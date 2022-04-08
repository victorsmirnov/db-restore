import {DBCluster, RDS} from "@aws-sdk/client-rds";
import {env} from "process";
import {App, Duration, SecretValue, Stack} from "aws-cdk-lib";
import {
    AuroraCapacityUnit,
    AuroraMysqlEngineVersion,
    DatabaseClusterEngine,
    ServerlessClusterFromSnapshot,
} from "aws-cdk-lib/aws-rds";
import {Peer, SubnetType, Vpc} from "aws-cdk-lib/aws-ec2";
import {CnameRecord, HostedZone} from "aws-cdk-lib/aws-route53";
import {CodeBuildStep, CodePipeline, CodePipelineSource} from "aws-cdk-lib/pipelines";
import {BuildEnvironmentVariableType, ComputeType, LinuxBuildImage} from "aws-cdk-lib/aws-codebuild";
import {ManagedPolicy, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {Rule, Schedule} from "aws-cdk-lib/aws-events";
import {CodePipeline as TargetCodePipeline} from "aws-cdk-lib/aws-events-targets";
import {Secret} from "aws-cdk-lib/aws-secretsmanager";
import {Trigger} from "aws-cdk-lib/triggers";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";

const rds = new RDS({});
const snapshotIdentifier = await findLatestSnapshotArn(env.SOURCE_CLUSTER_NAME);
const clusterProduction = await describeCluster(env.SOURCE_CLUSTER_NAME);
const engine = String(clusterProduction.Engine);
const engineVersion = String(clusterProduction.EngineVersion);

if (clusterProduction.Engine !== "aurora-mysql") {
    throw new Error(`Only aurora-mysql engine is supported. Cluster ${env.SOURCE_CLUSTER_NAME} is ${engine}`);
}

const app = new App();
const stack = new Stack(app, "RestoreStack", {
    env: {account: env.CDK_DEFAULT_ACCOUNT, region: env.CDK_DEFAULT_REGION},
    stackName: "database-restore",
});

const vpc = Vpc.fromLookup(stack, "VPC", {vpcId: env.VPC_ID});

const domainZonePrivate = HostedZone.fromLookup(stack, "ZonePrivate", {
    domainName: env.ZONE_NAME,
    privateZone: true,
    vpcId: env.VPC_ID,
});

const today = String(new Date().toISOString().split("T")[0]);
const clusterResource = `Database${today}`;
const clusterName = `${env.CLUSTER_NAME}-${today}`;
const databaseCluster = new ServerlessClusterFromSnapshot(stack, clusterResource, {
    backupRetention: Duration.days(1),
    clusterIdentifier: clusterName,
    enableDataApi: true,
    engine: DatabaseClusterEngine.auroraMysql({version: AuroraMysqlEngineVersion.of(engineVersion)}),
    scaling: {
        autoPause: Duration.minutes(30),
        minCapacity: AuroraCapacityUnit.ACU_8,
        maxCapacity: AuroraCapacityUnit.ACU_32,
    },
    snapshotIdentifier,
    vpc,
    vpcSubnets: {subnetType: SubnetType.PRIVATE_WITH_NAT},
});

databaseCluster.connections.allowDefaultPortFrom(Peer.ipv4(vpc.vpcCidrBlock));

const changePwdFunction = new NodejsFunction(stack, "ChangePwdFunction", {
    entry: "dist/ChangePassword.js",
    environment: {
        DATABASE_HOST: databaseCluster.clusterEndpoint.hostname,
        SOURCE_SECRETS: env.SOURCE_SECRETS,
        TARGET_SECRETS: env.TARGET_SECRETS,
    },
    handler: "handler",
    memorySize: 1024,
    runtime: Runtime.NODEJS_14_X,
    timeout: Duration.seconds(5),
    vpc,
});
/**
 * This is a workaround for the issue https://github.com/aws/aws-cdk/issues/19272
 */
changePwdFunction.grantInvoke(new ServicePrincipal("lambda.amazonaws.com"));
changePwdFunction.currentVersion.grantInvoke(new ServicePrincipal("lambda.amazonaws.com"));

let idx = 0;
for (const secretName of env.SOURCE_SECRETS.split(",")) {
    const secret = Secret.fromSecretNameV2(stack, `SourceSecret${idx++}`, secretName);
    secret.grantRead(changePwdFunction);
}
idx = 0;
for (const secretName of env.TARGET_SECRETS.split(",")) {
    const secret = Secret.fromSecretNameV2(stack, `TargetSecret${idx++}`, secretName);
    secret.grantRead(changePwdFunction);
    secret.grantWrite(changePwdFunction);
}

databaseCluster.connections.allowDefaultPortFrom(changePwdFunction);

const trigger = new Trigger(stack, "ChangePwdTrigger", {
    executeAfter: [databaseCluster],
    handler: changePwdFunction,
    executeOnHandlerChange: true,
});
/**
 * This is a workaround for the issue https://github.com/aws/aws-cdk/issues/19272
 */
trigger.node.addDependency(changePwdFunction);

new CnameRecord(stack, "CnameRecord", {
    recordName: env.CLUSTER_NAME,
    zone: domainZonePrivate,
    domainName: databaseCluster.clusterEndpoint.hostname,
});

const pipeline = new CodePipeline(stack, "DeploymentPipeline", {
    // selfMutation: false,
    codeBuildDefaults: {
        buildEnvironment: {
            buildImage: LinuxBuildImage.STANDARD_5_0,
            computeType: ComputeType.SMALL,
            environmentVariables: {
                CDK_DEFAULT_ACCOUNT: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.CDK_DEFAULT_ACCOUNT},
                CDK_DEFAULT_REGION: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.CDK_DEFAULT_REGION},
                CLUSTER_NAME: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.CLUSTER_NAME},
                GITHUB_BRANCH: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_BRANCH},
                GITHUB_REPO: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_REPO},
                GITHUB_SECRET: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_SECRET},
                PIPELINE_NAME: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.PIPELINE_NAME},
                SCHEDULE: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SCHEDULE},
                SOURCE_CLUSTER_NAME: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SOURCE_CLUSTER_NAME},
                SOURCE_SECRETS: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SOURCE_SECRETS},
                STACK_NAME: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.STACK_NAME},
                TARGET_SECRETS: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.TARGET_SECRETS},
                VPC_ID: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.VPC_ID},
                ZONE_NAME: {type: BuildEnvironmentVariableType.PLAINTEXT, value: env.ZONE_NAME},
            },
        },
    },
    crossAccountKeys: false,
    pipelineName: env.PIPELINE_NAME,
    synth: new CodeBuildStep("DeploymentStack", {
        input: CodePipelineSource.gitHub(env.GITHUB_REPO, env.GITHUB_BRANCH, {
            authentication: SecretValue.secretsManager(env.GITHUB_SECRET),
        }),
        commands: ["npm ci", "npm run build", "npx cdk synth"],
    }),
});
pipeline.buildPipeline();
pipeline.synthProject.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"));

new Rule(stack, "ScheduleRule", {
    schedule: Schedule.expression(env.SCHEDULE),
    targets: [new TargetCodePipeline(pipeline.pipeline)],
});

async function describeCluster(clusterIdentifier: string): Promise<DBCluster> {
    const clusters = (await rds.describeDBClusters({DBClusterIdentifier: "monolith-develop"})).DBClusters;
    if (clusters === undefined) {
        throw new Error("Failed to fetch cluster " + clusterIdentifier);
    }

    const cluster = clusters.shift();
    if (cluster === undefined) {
        throw new Error("Failed to fetch cluster " + clusterIdentifier);
    }

    return cluster;
}

async function findLatestSnapshotArn(cluster: string): Promise<string> {
    const snapshots = await rds.describeDBClusterSnapshots({
        DBClusterIdentifier: cluster,
        SnapshotType: "automated",
    });
    if (snapshots.DBClusterSnapshots === undefined) {
        throw new Error("Failed to find snapshots for " + cluster);
    }

    const snapshotArn = snapshots.DBClusterSnapshots.sort(
        (a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0)
    )
        .map((s) => s.DBClusterSnapshotArn)
        .shift();
    if (snapshotArn === undefined) {
        throw new Error("Failed to find snapshots for " + cluster);
    }

    return snapshotArn;
}
