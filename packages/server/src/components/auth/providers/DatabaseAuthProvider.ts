import { AuthResponseData } from "@aurora-launcher/core";
import { LauncherServerConfig } from "@root/components/config/utils/LauncherServerConfig";
import { LogHelper } from "@root/utils";
import { DataSource, EntitySchema, In, IsNull, MoreThan } from "typeorm";

import {
    AuthProvider,
    AuthProviderAuthMetadata,
    AuthProviderConfig,
    HasJoinedResponseData,
    ProfileResponseData,
    ProfilesResponseData,
} from "./AuthProvider";
import { randomUUID } from "crypto";
import { ResponseError } from "aurora-rpc-server";
import { DatabasePasswordProvider } from "./DatabasePasswordProvider";
import { SkinManager } from "../../skin/SkinManager";

export class DatabaseAuthProvider implements AuthProvider {
    private userRepository;
    private skinManager: SkinManager;
    private passwordProvider;
    private hwidBanRepository;
    private hwidSeenRepository;
    private hwidTrackingDisabled = false;

    constructor({ auth }: LauncherServerConfig, skinManager: SkinManager) {
        const authConfig = <DatabaseAuthProviderConfig>auth;
        this.passwordProvider = new DatabasePasswordProvider(authConfig);
        this.skinManager = skinManager;

        if (!authConfig.properties.tableName) {
            LogHelper.fatal("tableName not defined");
        }
        const UserEntity = getUserEntity(authConfig.properties);
        const hwidBans = resolveHwidBansConfig(authConfig.hwidBans);
        const hwidTracking = resolveHwidTrackingConfig(authConfig.hwidTracking);
        LogHelper.info(
            "HWID bans %s (table=%s, hashColumn=%s, expiresAtColumn=%s)",
            hwidBans.enabled ? "enabled" : "disabled",
            hwidBans.tableName,
            hwidBans.hashColumn,
            hwidBans.expiresAtColumn,
        );
        LogHelper.info(
            "HWID tracking %s (table=%s)",
            hwidTracking.enabled ? "enabled" : "disabled",
            hwidTracking.tableName,
        );
        const HwidBanEntity = hwidBans.enabled ? getHwidBanEntity(hwidBans) : undefined;
        const HwidSeenEntity = hwidTracking.enabled ? getHwidSeenEntity(hwidTracking) : undefined;
        const entities: EntitySchema[] = [UserEntity];
        if (HwidBanEntity) {
            entities.push(HwidBanEntity);
        }
        if (HwidSeenEntity) {
            entities.push(HwidSeenEntity);
        }

        const connection = new DataSource({
            ...authConfig.connection,
            entities,
        });

        connection.initialize().catch((error) => LogHelper.fatal(error));

        this.userRepository = connection.getRepository(UserEntity);
        if (HwidBanEntity) {
            this.hwidBanRepository = connection.getRepository(HwidBanEntity);
        }
        if (HwidSeenEntity) {
            this.hwidSeenRepository = connection.getRepository(HwidSeenEntity);
        }
    }

    async auth(
        username: string,
        password: string,
        metadata?: AuthProviderAuthMetadata,
    ): Promise<AuthResponseData> {
        const user = await this.userRepository.findOneBy({ username });
        if (!user) throw new ResponseError("User not found", 300);

        if (!(await this.passwordProvider.checkPassword(password, user.password)))
            throw new ResponseError("Wrong password", 301);

        if (metadata?.hwid) {
            LogHelper.info(
                "Auth HWID metadata received (user=%s, hwid=%s, version=%s)",
                username,
                formatHwidForLog(metadata.hwid),
                metadata.hwidVersion ?? "n/a",
            );
        } else {
            LogHelper.warn("Auth HWID metadata missing (user=%s)", username);
        }

        await this.ensureHwidIsNotBanned(username, metadata?.hwid);
        await this.trackHwidMetadata(user, metadata);

        const userData = {
            username,
            userUUID: user.userUUID,
            skinUrl: this.skinManager.getSkin(user.userUUID, username),
            capeUrl: this.skinManager.getCape(user.userUUID, username),
            accessToken: randomUUID(),
            token: "",
        };

        await this.userRepository.update(
            { userUUID: user.userUUID },
            { accessToken: userData.accessToken },
        );

        return userData;
    }

    async join(accessToken: string, userUUID: string, serverID: string): Promise<boolean> {
        const user = await this.userRepository.findOneBy({
            accessToken,
            userUUID,
        });
        if (!user) return false;

        user.serverID = serverID;
        await this.userRepository.save(user);

        return true;
    }

    async hasJoined(username: string, serverID: string): Promise<HasJoinedResponseData> {
        const user = await this.userRepository.findOneBy({ username });
        if (!user) throw new Error("User not found");
        if (user.serverID !== serverID) {
            throw new Error("Invalid serverId");
        }

        return {
            userUUID: user.userUUID,
            skinUrl: this.skinManager.getSkin(user.userUUID, username),
            capeUrl: this.skinManager.getCape(user.userUUID, username),
        };
    }

    async profile(userUUID: string): Promise<ProfileResponseData> {
        const user = await this.userRepository.findOneBy({ userUUID });
        if (!user) throw new Error("User not found");

        return {
            username: user.username,
            skinUrl: this.skinManager.getSkin(userUUID, user.username),
            capeUrl: this.skinManager.getCape(userUUID, user.username),
        };
    }

    async profiles(usernames: string[]): Promise<ProfilesResponseData[]> {
        return [...(await this.userRepository.findBy({ username: In(usernames) }))].map((user) => ({
            id: user.userUUID,
            name: user.username,
        }));
    }

    private async ensureHwidIsNotBanned(username: string, hwid?: string): Promise<void> {
        if (!this.hwidBanRepository || !hwid) return;

        const normalizedHwid = hwid.trim().toLowerCase();
        if (!normalizedHwid) return;

        const ban = await this.hwidBanRepository.findOne({
            where: [
                { hwidHash: normalizedHwid, expiresAt: IsNull() },
                {
                    hwidHash: normalizedHwid,
                    expiresAt: MoreThan(new Date()),
                },
            ],
            order: { id: "DESC" },
        });

        if (ban) {
            LogHelper.warn(
                "HWID is banned (user=%s, hwid=%s)",
                username,
                formatHwidForLog(normalizedHwid),
            );
            throw new ResponseError("HWID_BANNED", 302);
        }
    }

    private async trackHwidMetadata(
        user: Pick<UserEntity, "username" | "userUUID">,
        metadata?: AuthProviderAuthMetadata,
    ): Promise<void> {
        if (!this.hwidSeenRepository || this.hwidTrackingDisabled) return;

        if (!metadata?.hwid) {
            LogHelper.info("HWID tracking skipped: empty hwid (user=%s)", user.username);
            return;
        }

        const normalizedHwid = metadata.hwid.trim().toLowerCase();
        if (!normalizedHwid) {
            LogHelper.info("HWID tracking skipped: blank hwid after normalize (user=%s)", user.username);
            return;
        }

        const hwidVersion = metadata.hwidVersion?.trim() || null;
        const now = new Date();

        try {
            const existing = await this.hwidSeenRepository.findOneBy({
                userUUID: user.userUUID,
                hwidHash: normalizedHwid,
            });

            if (existing) {
                existing.username = user.username;
                existing.hwidVersion = hwidVersion ?? existing.hwidVersion;
                existing.lastSeenAt = now;
                await this.hwidSeenRepository.save(existing);
                LogHelper.info(
                    "HWID tracking updated (user=%s, hwid=%s, version=%s)",
                    user.username,
                    formatHwidForLog(normalizedHwid),
                    hwidVersion ?? existing.hwidVersion ?? "n/a",
                );
                return;
            }

            await this.hwidSeenRepository.save({
                username: user.username,
                userUUID: user.userUUID,
                hwidHash: normalizedHwid,
                hwidVersion,
                firstSeenAt: now,
                lastSeenAt: now,
            });
            LogHelper.info(
                "HWID tracking inserted (user=%s, hwid=%s, version=%s)",
                user.username,
                formatHwidForLog(normalizedHwid),
                hwidVersion ?? "n/a",
            );
        } catch (error) {
            this.hwidTrackingDisabled = true;
            LogHelper.warn(
                "HWID tracking disabled: failed to persist metadata (user=%s, hwid=%s, error=%s)",
                user.username,
                formatHwidForLog(normalizedHwid),
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}

const formatHwidForLog = (hwid?: string): string => {
    const normalizedHwid = hwid?.trim().toLowerCase();
    if (!normalizedHwid) return "empty";
    if (normalizedHwid.length <= 16) return normalizedHwid;
    return `${normalizedHwid.slice(0, 8)}...${normalizedHwid.slice(-8)}`;
};

const getUserEntity = (properties: DatabaseAuthProviderConfig["properties"]) => {
    return new EntitySchema<UserEntity>({
        name: "user",
        tableName: properties.tableName,
        columns: {
            username: {
                type: String,
                unique: true,
                name: properties.usernameColumn,
            },
            password: {
                type: String,
                name: properties.passwordColumn,
            },
            userUUID: {
                type: String,
                unique: true,
                primary: true,
                generated: "uuid",
                name: properties.uuidColumn,
            },
            accessToken: {
                type: String,
                name: properties.accessTokenColumn,
            },
            serverID: {
                type: String,
                name: properties.serverIdColumn,
            },
        },
    });
};

const getHwidBanEntity = (hwidBans: ResolvedHwidBansConfig) => {
    return new EntitySchema<HwidBanEntity>({
        name: "hwidBan",
        tableName: hwidBans.tableName,
        columns: {
            id: {
                type: Number,
                primary: true,
                generated: true,
            },
            hwidHash: {
                type: String,
                name: hwidBans.hashColumn,
            },
            expiresAt: {
                type: Date,
                nullable: true,
                name: hwidBans.expiresAtColumn,
            },
        },
    });
};

const getHwidSeenEntity = (hwidTracking: ResolvedHwidTrackingConfig) => {
    return new EntitySchema<HwidSeenEntity>({
        name: "hwidSeen",
        tableName: hwidTracking.tableName,
        columns: {
            id: {
                type: Number,
                primary: true,
                generated: true,
            },
            username: {
                type: String,
                name: hwidTracking.usernameColumn,
            },
            userUUID: {
                type: String,
                name: hwidTracking.uuidColumn,
            },
            hwidHash: {
                type: String,
                name: hwidTracking.hashColumn,
            },
            hwidVersion: {
                type: String,
                nullable: true,
                name: hwidTracking.versionColumn,
            },
            firstSeenAt: {
                type: Date,
                name: hwidTracking.firstSeenAtColumn,
            },
            lastSeenAt: {
                type: Date,
                name: hwidTracking.lastSeenAtColumn,
            },
        },
        indices: [
            {
                columns: ["userUUID", "hwidHash"],
                unique: true,
            },
            {
                columns: ["hwidHash"],
            },
            {
                columns: ["lastSeenAt"],
            },
        ],
    });
};

export class DatabaseAuthProviderConfig extends AuthProviderConfig {
    passwordVerfier: string;
    passwordSalt?: string;
    connection: {
        type: AvaliableDataBaseType;
        host: string;
        port: number;
        username: string;
        password: string;
        database: string;
    };
    properties: {
        tableName: string;
        uuidColumn: string;
        usernameColumn: string;
        passwordColumn: string;
        accessTokenColumn: string;
        serverIdColumn: string;
    };
    hwidBans?: {
        enabled?: boolean;
        tableName?: string;
        hashColumn?: string;
        expiresAtColumn?: string;
    };
    hwidTracking?: {
        enabled?: boolean;
        tableName?: string;
        usernameColumn?: string;
        uuidColumn?: string;
        hashColumn?: string;
        versionColumn?: string;
        firstSeenAtColumn?: string;
        lastSeenAtColumn?: string;
    };
}

type AvaliableDataBaseType = "mysql" | "mariadb" | "postgres" | "sqlite" | "oracle" | "mssql";

interface HwidBanEntity {
    id: number;
    hwidHash: string;
    expiresAt: Date | null;
}

interface ResolvedHwidBansConfig {
    enabled: boolean;
    tableName: string;
    hashColumn: string;
    expiresAtColumn: string;
}

interface HwidSeenEntity {
    id: number;
    username: string;
    userUUID: string;
    hwidHash: string;
    hwidVersion: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

interface ResolvedHwidTrackingConfig {
    enabled: boolean;
    tableName: string;
    usernameColumn: string;
    uuidColumn: string;
    hashColumn: string;
    versionColumn: string;
    firstSeenAtColumn: string;
    lastSeenAtColumn: string;
}

interface UserEntity {
    username: string;
    password: string;
    userUUID: string;
    accessToken: string;
    serverID: string;
}

const resolveHwidBansConfig = (
    hwidBans?: DatabaseAuthProviderConfig["hwidBans"],
): ResolvedHwidBansConfig => ({
    enabled: hwidBans?.enabled ?? true,
    tableName: hwidBans?.tableName ?? "launcher_hwid_bans",
    hashColumn: hwidBans?.hashColumn ?? "hwid_hash",
    expiresAtColumn: hwidBans?.expiresAtColumn ?? "expires_at",
});

const resolveHwidTrackingConfig = (
    hwidTracking?: DatabaseAuthProviderConfig["hwidTracking"],
): ResolvedHwidTrackingConfig => ({
    enabled: hwidTracking?.enabled ?? true,
    tableName: hwidTracking?.tableName ?? "launcher_hwid_seen",
    usernameColumn: hwidTracking?.usernameColumn ?? "username",
    uuidColumn: hwidTracking?.uuidColumn ?? "user_uuid",
    hashColumn: hwidTracking?.hashColumn ?? "hwid_hash",
    versionColumn: hwidTracking?.versionColumn ?? "hwid_version",
    firstSeenAtColumn: hwidTracking?.firstSeenAtColumn ?? "first_seen_at",
    lastSeenAtColumn: hwidTracking?.lastSeenAtColumn ?? "last_seen_at",
});
