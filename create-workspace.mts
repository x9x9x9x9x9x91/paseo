// Opens a directory workspace with its first agent, the way the app's new-workspace screen does,
// then prints the workspace's title after the namer has had time to run.
// tsx create-workspace.mts <repo> <host> <dir> <provider> <prompt> <waitMs>
const [repo, host, dir, provider, prompt, waitMs] = process.argv.slice(2);
const { connectToDaemon } = await import(`${repo}/packages/cli/src/utils/client.ts`);
const client = await connectToDaemon({ target: { kind: "endpoint", host } });
const payload = await client.createWorkspace({
  source: { kind: "directory", path: dir },
  agent: { provider, cwd: dir, initialPrompt: prompt },
});
const workspaceId = payload.workspace?.id;
console.log(`created workspace ${workspaceId} with agent ${payload.agent?.id} on ${provider}`);
await new Promise((resolve) => setTimeout(resolve, Number(waitMs)));
const listed = await client.fetchWorkspaces();
const entries = listed.entries ?? listed.workspaces ?? [];
const workspace = entries.find((entry: any) => (entry.id ?? entry.workspace?.id) === workspaceId);
console.log(`workspace title after ${waitMs} ms: ${JSON.stringify(workspace?.title ?? workspace?.name ?? workspace?.workspace?.title ?? null)}`);
await client.close();
process.exit(0);
