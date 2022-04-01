declare global {
    namespace NodeJS {
        interface ProcessEnv {
            CDK_DEFAULT_ACCOUNT: string;

            CDK_DEFAULT_REGION: string;

            CLUSTER_NAME: string;

            GITHUB_BRANCH: string;

            GITHUB_REPO: string;

            GITHUB_SECRET: string;

            SCHEDULE: string;

            SECRET_NAME: string;

            PIPELINE_NAME: string;

            SOURCE_CLUSTER_NAME: string;

            SOURCE_SECRET_NAME: string;

            STACK_NAME: string;

            VPC_ID: string;

            ZONE_NAME: string;
        }
    }
}

export {};
