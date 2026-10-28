import { AgentToken } from "@/components/agent-token"
import { DeleteCluster } from "@/components/delete-cluster"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getCluster } from "@/lib/api"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string }>
}) {
  const { cluster } = await params
  const stats = await getCluster(cluster)

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 pt-0">
      <h1 className="text-lg font-medium">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Cluster</CardTitle>
          <CardDescription>
            The name is part of the address and cannot be changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <span className="font-mono">{stats.name}</span>
          <span className="text-muted-foreground">
            {stats.nodes} {stats.nodes === 1 ? "node" : "nodes"} ·{" "}
            {stats.tests} {stats.tests === 1 ? "test" : "tests"}
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent token</CardTitle>
          <CardDescription>
            One token for the whole cluster. Start an agent on a machine with{" "}
            <code className="font-mono text-xs">
              --cluster {cluster} --name &lt;node&gt; --token &lt;token&gt;
            </code>
            ; the node is added to the cluster under that name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgentToken cluster={cluster} />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete cluster</CardTitle>
          <CardDescription>
            Removes the cluster with its nodes, tests, logs and sensor
            history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteCluster stats={stats} />
        </CardContent>
      </Card>
    </div>
  )
}
