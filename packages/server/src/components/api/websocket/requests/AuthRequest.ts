import type { AuthRequestData, AuthResponseData } from "@aurora-launcher/core";
import type { AuthProvider, AuthProviderAuthMetadata } from "@root/components/auth/providers";
import { JsonHelper } from "@aurora-launcher/core";
import { VerifyManager } from "@root/components";
import { LogHelper } from "@root/utils";
import { AbstractRequest } from "aurora-rpc-server";
import { Inject, Service } from "typedi";

import type { ExtendedWebSocketClient } from "../ExtendedWebSocketClient";
import { VerifyMiddleware } from "./VerifyMiddleware";

@Service()
export class AuthWsRequest extends AbstractRequest {
    method = "auth";

    constructor(@Inject("AuthProvider") private authProvider: AuthProvider, private verifyManager: VerifyManager) {
        super();
    }

    /**
     * It takes a login and password, passes them to the auth provider, and returns the result
     * @param data - the data that was sent from the client
     * @param ws - the client that sent the request
     * @returns Promise<AuthResponseData>
     */
    @VerifyMiddleware()
    async invoke(data: AuthRequestData, ws: ExtendedWebSocketClient): Promise<AuthResponseData> {
        const { login, password, hwid, hwidVersion } = data as AuthRequestData &
            AuthProviderAuthMetadata;

        if (hwid) {
            LogHelper.info(
                "WS auth payload contains HWID (user=%s, hwid=%s, version=%s)",
                login,
                formatHwidForLog(hwid),
                hwidVersion ?? "n/a",
            );
        } else {
            LogHelper.warn("WS auth payload has no HWID (user=%s)", login);
        }

        const res = await this.authProvider.auth(login, password, { hwid, hwidVersion });
        const authData = JsonHelper.toJson({ login, password });
        res.token = this.verifyManager.encryptToken(Buffer.from(authData, "utf8").toString("hex"));
        ws.isAuthed = true;
        return res;
    }
}

const formatHwidForLog = (hwid: string): string => {
    const normalizedHwid = hwid.trim().toLowerCase();
    if (normalizedHwid.length <= 16) return normalizedHwid;
    return `${normalizedHwid.slice(0, 8)}...${normalizedHwid.slice(-8)}`;
};
