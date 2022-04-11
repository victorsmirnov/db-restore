import { env } from 'process'
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { Connection, createConnection } from 'mysql'

export async function handler (): Promise<void> {
  const host = String(env.DATABASE_HOST)
  const sourceNames = env.SOURCE_SECRETS.split(',')
  const targetNames = env.TARGET_SECRETS.split(',')

  for (let idx = 0; idx < sourceNames.length; ++idx) {
    try {
      await processSecrets(host, String(sourceNames[idx]), String(targetNames[idx]))
    } catch (error) {
      console.log('Failed to update password', {
        host,
        sourceSecret: sourceNames[idx],
        targetSecret: targetNames[idx],
        error
      })
    }
  }
}

interface DatabaseSecret {
  dbClusterIdentifier: string
  engine: string
  host: string
  password: string
  port: number
  username: string
}

async function processSecrets (host: string, sourceName: string, targetName: string): Promise<boolean> {
  const sourceSecret = await readSecret(sourceName)
  const targetSecret = await readSecret(targetName)

  if (targetSecret.host !== host) {
    targetSecret.host = host
    await updateSecret(targetName, targetSecret)
    console.log('Updated host in the secret', { secretName: targetName, newHost: host })
  }

  if (await checkLogin({ ...sourceSecret, host })) {
    await updatePassword({ ...sourceSecret, host }, targetSecret.password)
    console.log('Updated database password', { host, username: targetSecret.username })
  }

  if (!(await checkLogin(await readSecret(targetName)))) {
    console.log('Password verification failed', { host, secret: targetName, username: targetSecret.username })
    return false
  }

  console.log('Password verified', { host, secret: targetName, username: targetSecret.username })
  return true
}

const client = new SecretsManagerClient({ region: env['AWS_REGION'] })

async function readSecret (secretName: string): Promise<DatabaseSecret> {
  const secret = await client.send(new GetSecretValueCommand({ SecretId: secretName }))
  const secretString = String(secret.SecretString)
  return JSON.parse(secretString) as DatabaseSecret
}

async function updateSecret (secretName: string, secretValue: DatabaseSecret): Promise<void> {
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretName,
      SecretString: JSON.stringify(secretValue)
    })
  )
}

function mysqlConnection (secret: DatabaseSecret): Connection {
  return createConnection({
    host: secret.host,
    user: secret.username,
    password: secret.password
  })
}

async function checkLogin (secret: DatabaseSecret): Promise<boolean> {
  return await new Promise((resolve) => mysqlConnection(secret).ping((error) => resolve(error === null)))
}

async function updatePassword (secret: DatabaseSecret, newPassword: string): Promise<void> {
  return await new Promise((resolve, reject) =>
    mysqlConnection(secret).query('set password = PASSWORD(?)', [newPassword], (error) => {
      if (error !== null) {
        reject(error)
      }
      resolve()
    })
  )
}
