import { App } from 'aws-cdk-lib'
import { createRestoreStack } from './RestoreStack.js'

const app = new App()
await createRestoreStack(app)
