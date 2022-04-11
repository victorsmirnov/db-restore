declare global {
  namespace NodeJS {
    interface ProcessEnv {
      CDK_DEFAULT_ACCOUNT: string

      CDK_DEFAULT_REGION: string

      CLUSTER_NAME: string

      DATABASE_HOST?: string

      GITHUB_BRANCH: string

      GITHUB_REPO: string

      GITHUB_SECRET: string

      SCHEDULE: string

      PIPELINE_NAME: string

      SOURCE_CLUSTER_NAME: string

      SOURCE_SECRETS: string

      STACK_NAME: string

      TARGET_SECRETS: string

      VPC_ID: string

      ZONE_NAME: string
    }
  }
}

export {}
