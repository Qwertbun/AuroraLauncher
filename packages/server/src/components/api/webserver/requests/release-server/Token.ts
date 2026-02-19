import { SecureHelper } from "@root/utils";
import { VerifyManager } from "@root/components/secure/VerifyManager";
import { Service } from "typedi";

@Service()
export class TokenManager {
    private token: string;
    private encryptedToken: string;

    constructor(private verifyManager: VerifyManager) {
        this.token = SecureHelper.generateRandomToken(32);
        this.encryptedToken = this.verifyManager.encryptToken(this.token);
    }
    
    public getToken(){
        return this.token
    }
    public getEncryptedToken(){
        return this.encryptedToken
    }
}
