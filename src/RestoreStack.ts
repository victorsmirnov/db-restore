import { Duration, SecretValue, Stack } from 'aws-cdk-lib'
import { env } from 'process'
import { Peer, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import { CnameRecord, HostedZone } from 'aws-cdk-lib/aws-route53'
import {
  AuroraCapacityUnit,
  AuroraMysqlEngineVersion,
  DatabaseClusterEngine,
  ServerlessClusterFromSnapshot
} from 'aws-cdk-lib/aws-rds'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { ManagedPolicy, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'
import { Trigger } from 'aws-cdk-lib/triggers'
import { CodeBuildStep, CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines'
import { BuildEnvironmentVariableType, ComputeType, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild'
import { Rule, Schedule } from 'aws-cdk-lib/aws-events'
import { CodePipeline as TargetCodePipeline } from 'aws-cdk-lib/aws-events-targets'
import { Construct } from 'constructs'
import { describeCluster, findLatestSnapshotArn } from './RdsUtils.js'
import { Pipeline } from 'aws-cdk-lib/aws-codepipeline'
import { Bucket } from 'aws-cdk-lib/aws-s3'

export async function createRestoreStack (scope: Construct): Promise<Stack> {
  const snapshotIdentifier = await findLatestSnapshotArn(env.SOURCE_CLUSTER_NAME)
  const clusterProduction = await describeCluster(env.SOURCE_CLUSTER_NAME)
  const engine = String(clusterProduction.Engine)
  const engineVersion = String(clusterProduction.EngineVersion)

  if (clusterProduction.Engine !== 'aurora-mysql') {
    throw new Error(`Only aurora-mysql engine is supported. Cluster ${env.SOURCE_CLUSTER_NAME} is ${engine}`)
  }

  const stackName = 'database-restore'
  const stack = new Stack(scope, 'RestoreStack', {
    env: { account: env.CDK_DEFAULT_ACCOUNT, region: env.CDK_DEFAULT_REGION },
    stackName
  })

  const vpc = Vpc.fromLookup(stack, 'VPC', { vpcId: env.VPC_ID })

  const domainZonePrivate = HostedZone.fromLookup(stack, 'ZonePrivate', {
    domainName: env.ZONE_NAME,
    privateZone: true,
    vpcId: env.VPC_ID
  })

  const today = String(new Date().toISOString().split('T')[0])
  const clusterResource = `Database${today}`
  const clusterName = `${env.CLUSTER_NAME}-${today}`
  const databaseCluster = new ServerlessClusterFromSnapshot(stack, clusterResource, {
    backupRetention: Duration.days(1),
    clusterIdentifier: clusterName,
    enableDataApi: true,
    engine: DatabaseClusterEngine.auroraMysql({ version: AuroraMysqlEngineVersion.of(engineVersion) }),
    scaling: {
      autoPause: Duration.minutes(30),
      minCapacity: AuroraCapacityUnit.ACU_8,
      maxCapacity: AuroraCapacityUnit.ACU_32
    },
    snapshotIdentifier,
    vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_NAT }
  })

  databaseCluster.connections.allowDefaultPortFrom(Peer.ipv4(vpc.vpcCidrBlock))

  const changePwdFunction = new NodejsFunction(stack, 'ChangePwdFunction', {
    entry: 'src/ChangePassword.ts',
    environment: {
      DATABASE_HOST: databaseCluster.clusterEndpoint.hostname,
      SOURCE_SECRETS: env.SOURCE_SECRETS,
      TARGET_SECRETS: env.TARGET_SECRETS
    },
    handler: 'handler',
    memorySize: 1024,
    runtime: Runtime.NODEJS_14_X,
    timeout: Duration.seconds(60),
    vpc
  })
  /**
   * This is a workaround for the issue https://github.com/aws/aws-cdk/issues/19272#issuecomment-1092695097
   * Step 1: Grant permission to anyone to execute the lambda.
   */
  changePwdFunction.grantInvoke(new ServicePrincipal('lambda.amazonaws.com'))
  changePwdFunction.currentVersion.grantInvoke(new ServicePrincipal('lambda.amazonaws.com'))

  let idx = 0
  for (const secretName of env.SOURCE_SECRETS.split(',')) {
    const secret = Secret.fromSecretNameV2(stack, `SourceSecret${idx++}`, secretName)
    secret.grantRead(changePwdFunction)
  }
  idx = 0
  for (const secretName of env.TARGET_SECRETS.split(',')) {
    const secret = Secret.fromSecretNameV2(stack, `TargetSecret${idx++}`, secretName)
    secret.grantRead(changePwdFunction)
    secret.grantWrite(changePwdFunction)
  }

  databaseCluster.connections.allowDefaultPortFrom(changePwdFunction)

  const trigger = new Trigger(stack, 'ChangePwdTrigger', {
    executeAfter: [databaseCluster],
    handler: changePwdFunction,
    executeOnHandlerChange: true
  })
  /**
   * Step 2: Make sure we finish lambda changes (including permissions) before dealing with the trigger.
   */
  trigger.node.addDependency(changePwdFunction)

  // eslint-disable-next-line no-new
  new CnameRecord(stack, 'CnameRecord', {
    recordName: env.CLUSTER_NAME,
    zone: domainZonePrivate,
    domainName: databaseCluster.clusterEndpoint.hostname
  })

  const pipeline = new CodePipeline(stack, 'DeploymentPipeline', {
    // selfMutation: false,
    codeBuildDefaults: {
      buildEnvironment: {
        buildImage: LinuxBuildImage.STANDARD_5_0,
        computeType: ComputeType.SMALL,
        environmentVariables: {
          CLUSTER_NAME: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.CLUSTER_NAME },
          GITHUB_BRANCH: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_BRANCH },
          GITHUB_REPO: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_REPO },
          GITHUB_SECRET: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.GITHUB_SECRET },
          PIPELINE_NAME: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.PIPELINE_NAME },
          SCHEDULE: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SCHEDULE },
          SOURCE_CLUSTER_NAME: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SOURCE_CLUSTER_NAME },
          SOURCE_SECRETS: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.SOURCE_SECRETS },
          STACK_NAME: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.STACK_NAME },
          TARGET_SECRETS: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.TARGET_SECRETS },
          VPC_ID: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.VPC_ID },
          ZONE_NAME: { type: BuildEnvironmentVariableType.PLAINTEXT, value: env.ZONE_NAME }
        }
      }
    },
    codePipeline: new Pipeline(stack, 'CodePipeline', {
      artifactBucket: Bucket.fromBucketName(stack, 'BuildBucket', 'build-all-projects'),
      crossAccountKeys: false,
      pipelineName: env.PIPELINE_NAME
    }),
    synth: new CodeBuildStep('DeploymentStack', {
      input: CodePipelineSource.gitHub(env.GITHUB_REPO, env.GITHUB_BRANCH, {
        authentication: SecretValue.secretsManager(env.GITHUB_SECRET)
      }),
      commands: ['npm ci', 'npm run build', `npx cdk --context stack-name=${stackName} synth`]
    })
  })
  pipeline.buildPipeline()
  pipeline.synthProject.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'))

  // eslint-disable-next-line no-new
  new Rule(stack, 'ScheduleRule', {
    schedule: Schedule.expression(env.SCHEDULE),
    targets: [new TargetCodePipeline(pipeline.pipeline)]
  })

  return stack
}
