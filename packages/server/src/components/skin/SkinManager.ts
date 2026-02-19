import { SkinConfig } from "../config/utils/SkinConfig";

export class SkinManager {
    private skinUrl: string;
    private capeUrl: string;

    constructor(skin: SkinConfig) {
        this.skinUrl = skin.skinUrl;
        this.capeUrl = skin.capeUrl;
    }

    getSkin(uuid: string, username: string): string {
        return this.resolveTemplate(this.skinUrl, uuid, username);
    }

    getCape(uuid: string, username: string): string {
        return this.resolveTemplate(this.capeUrl, uuid, username);
    }

    getDomainUrl() {
        return new URL(this.skinUrl).hostname;
    }

    private resolveTemplate(template: string, uuid: string, username: string): string {
        // Encode replacements to keep generated URLs valid for non-latin/special usernames.
        return template
            .replace(/\{uuid\}/g, encodeURIComponent(uuid))
            .replace(/\{username\}/g, encodeURIComponent(username));
    }
}
