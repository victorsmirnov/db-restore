import {CloudFormationCustomResourceEvent} from "aws-lambda";
import {
    GetSecretValueCommand,
    SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {env} from "process";

export async function handler(
    event: CloudFormationCustomResourceEvent
): Promise<void> {
    console.log("event 👉", event);

    const client = new SecretsManagerClient({region: env["AWS_REGION"]});
    const command = new GetSecretValueCommand({
        SecretId: env.SOURCE_SECRET_NAME,
    });
    const response = await client.send(command);

    console.log("secret ARN", response.ARN);
}
