import {env} from "process";
import {GetSecretValueCommand, SecretsManagerClient} from "@aws-sdk/client-secrets-manager";
import {createConnection} from "mysql";

export async function handler(): Promise<void> {
    const sourceSecret = await readSecret(env.SOURCE_MASTER_SECRET);
    const masterSecret = await readSecret(env.MASTER_SECRET);

    await updatePassword(masterSecret, sourceSecret.password);
}

const client = new SecretsManagerClient({region: env["AWS_REGION"]});

interface DatabaseSecret {
    dbClusterIdentifier: string;
    engine: string;
    host: string;
    password: string;
    port: number;
    username: string;
}

async function readSecret(secretName: string): Promise<DatabaseSecret> {
    const secret = await client.send(new GetSecretValueCommand({SecretId: secretName}));
    const secretString = String(secret.SecretString);
    return JSON.parse(secretString) as DatabaseSecret;
}

async function updatePassword(secret: DatabaseSecret, currentPwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const connection = createConnection({
            host: secret.host,
            user: secret.username,
            password: currentPwd,
        });
        connection.query(`set password = PASSWORD(?)`, [secret.password], (error) => {
            if (error !== null) {
                console.log("Failed to update password", {
                    host: secret.host,
                    user: secret.username,
                    error,
                });
                reject(error);
            }
            console.log("Updated password", {host: secret.host, user: secret.username});
            resolve();
        });
    });
}
