import {CloudFormationCustomResourceEvent} from "aws-lambda";
import {env} from "process";
import {GetSecretValueCommand, SecretsManagerClient} from "@aws-sdk/client-secrets-manager";

export async function handler(event: CloudFormationCustomResourceEvent): Promise<void> {
    console.log("event 👉", event);
    console.log("secret name 👉", env.SECRET_NAME);

    const client = new SecretsManagerClient({region: env["AWS_REGION"]});
    const command = new GetSecretValueCommand({SecretId: env.SECRET_NAME});
    const response = await client.send(command);

    console.log("root secret ARN 👉", response.ARN);
}
