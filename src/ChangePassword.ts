import {env} from "process";
import {GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient} from "@aws-sdk/client-secrets-manager";
import {Connection, createConnection} from "mysql";

export async function handler(): Promise<void> {
    const host = String(env.DATABASE_HOST);
    const sourceNames = env.SOURCE_SECRETS.split(",");
    const targetNames = env.TARGET_SECRETS.split(",");

    for (let idx = 0; idx < sourceNames.length; ++idx) {
        await processSecrets(host, String(sourceNames[idx]), String(targetNames[idx]));
    }
}

interface DatabaseSecret {
    dbClusterIdentifier: string;
    engine: string;
    host: string;
    password: string;
    port: number;
    username: string;
}

async function processSecrets(host: string, sourceName: string, targetName: string): Promise<boolean> {
    const sourceSecret = await readSecret(sourceName);
    const targetSecret = await readSecret(targetName);

    if (targetSecret.host !== host) {
        targetSecret.host = host;
        await updateSecret(targetName, targetSecret);
        console.log("Update secret", {secret: targetSecret, host});
    }

    if (await checkLogin({...sourceSecret, host})) {
        await updatePassword({...sourceSecret, host}, targetSecret.password);
    }

    if (!(await checkLogin(await readSecret(targetName)))) {
        console.log("Password not updated", {host, username: targetSecret.username});
        return false;
    }

    console.log("Password updated", {host: targetSecret.host, username: targetSecret.username});
    return true;
}

const client = new SecretsManagerClient({region: env["AWS_REGION"]});

async function readSecret(secretName: string): Promise<DatabaseSecret> {
    const secret = await client.send(new GetSecretValueCommand({SecretId: secretName}));
    const secretString = String(secret.SecretString);
    return JSON.parse(secretString) as DatabaseSecret;
}

async function updateSecret(secretName: string, secretValue: DatabaseSecret): Promise<void> {
    await client.send(
        new PutSecretValueCommand({
            SecretId: secretName,
            SecretString: JSON.stringify(secretValue),
        })
    );
}

function mysqlConnection(secret: DatabaseSecret): Connection {
    return createConnection({
        host: secret.host,
        user: secret.username,
        password: secret.password,
    });
}

async function checkLogin(secret: DatabaseSecret): Promise<boolean> {
    return new Promise((resolve) => mysqlConnection(secret).ping((error) => resolve(error === null)));
}

async function updatePassword(secret: DatabaseSecret, newPassword: string): Promise<void> {
    return new Promise((resolve, reject) =>
        mysqlConnection(secret).query(`set password = PASSWORD(?)`, [newPassword], (error) => {
            if (error !== null) {
                console.log("Failed to update password", {host: secret.host, user: secret.username, error});
                reject(error);
            }
            console.log("Updated password", {host: secret.host, user: secret.username});
            resolve();
        })
    );
}
