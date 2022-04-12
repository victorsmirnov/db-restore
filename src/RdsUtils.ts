import { DBCluster, RDS } from '@aws-sdk/client-rds'

const rds = new RDS({})

export async function describeCluster (clusterIdentifier: string): Promise<DBCluster> {
  const clusters = (await rds.describeDBClusters({ DBClusterIdentifier: 'monolith-develop' })).DBClusters
  if (clusters === undefined) {
    throw new Error('Failed to fetch cluster ' + clusterIdentifier)
  }

  const cluster = clusters.shift()
  if (cluster === undefined) {
    throw new Error('Failed to fetch cluster ' + clusterIdentifier)
  }

  return cluster
}

export async function findLatestSnapshotArn (cluster: string): Promise<string> {
  const snapshots = await rds.describeDBClusterSnapshots({
    DBClusterIdentifier: cluster,
    SnapshotType: 'automated'
  })
  if (snapshots.DBClusterSnapshots === undefined) {
    throw new Error('Failed to find snapshots for ' + cluster)
  }

  const snapshotArn = snapshots.DBClusterSnapshots.sort(
    (a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0)
  )
    .map((s) => s.DBClusterSnapshotArn)
    .shift()
  if (snapshotArn === undefined) {
    throw new Error('Failed to find snapshots for ' + cluster)
  }

  return snapshotArn
}
