import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import io from 'socket.io-client';

type PublishStatus = 'written' | 'unchanged' | 'editedOnWeb';

interface CodimdDocument {
  str: string;
  revision: number;
}

export function decide(
  lastPushed: string | null,
  remote: string,
  content: string,
): 'unchanged' | 'editedOnWeb' | 'write' {
  if (remote === content) return 'unchanged';
  const editedOnWeb = lastPushed === null ? remote.length > 0 : remote !== lastPushed;
  return editedOnWeb ? 'editedOnWeb' : 'write';
}

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const pushedPath = (alias: string) =>
  join(process.env.STATE_DIR ?? 'state', 'codimd', `${alias}.md`);

function readLastPushed(alias: string): string | null {
  try {
    return readFileSync(pushedPath(alias), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function rememberPushed(alias: string, content: string): void {
  mkdirSync(dirname(pushedPath(alias)), { recursive: true });
  writeFileSync(pushedPath(alias), content);
}

async function login(server: string): Promise<string> {
  const response = await fetch(`${server}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: requiredEnv('CODIMD_EMAIL'),
      password: requiredEnv('CODIMD_PASSWORD'),
    }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('connect.sid='));
  if (!cookie) throw new Error(`CodiMD login failed: HTTP ${response.status}`);
  const me = (await (await fetch(`${server}/me`, { headers: { Cookie: cookie } })).json()) as {
    status: string;
  };
  if (me.status !== 'ok') throw new Error('CodiMD login failed: /me is not ok');
  return cookie;
}

// CodiMD has no HTTP write for a named note, so the content goes through the realtime
// socket.io channel as one OT operation: [delete old, insert new].
function writeThroughSocket(
  server: string,
  alias: string,
  cookie: string,
  content: string,
  lastPushed: string | null,
): Promise<PublishStatus> {
  return new Promise((resolve, reject) => {
    const socket = io(server, {
      query: { noteId: alias },
      transports: ['polling'], // websocket drops extraHeaders under Node, so the session cookie would be lost
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    const finish = (outcome: PublishStatus | Error) => {
      clearTimeout(timer);
      socket.close();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(() => finish(new Error('timeout waiting for CodiMD')), 20_000);
    socket.on('connect_error', (error: Error) =>
      finish(new Error(`CodiMD socket: ${error.message}`)),
    );
    socket.on('error', (error) => finish(new Error(`CodiMD socket: ${error}`)));
    socket.on('info', (info) => finish(new Error(`CodiMD socket info: ${JSON.stringify(info)}`)));
    socket.once('doc', (doc: CodimdDocument) => {
      const decision = decide(lastPushed, doc.str, content);
      if (decision === 'unchanged') return finish('unchanged');
      if (decision === 'editedOnWeb') return finish('editedOnWeb');
      const operation = doc.str.length ? [-doc.str.length, content] : [content];
      socket.once('ack', () => finish('written'));
      socket.emit('operation', doc.revision, operation, null);
    });
  });
}

async function waitUntilSaved(server: string, alias: string, content: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${server}/${alias}/download`);
    if (response.ok && (await response.text()) === content) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`CodiMD note ${alias} did not match the pushed content within 30 seconds`);
}

export async function publish(
  alias: string,
  markdown: string,
): Promise<{ url: string; status: PublishStatus }> {
  const server = requiredEnv('CODIMD_URL');
  const cookie = await login(server);
  // GET while logged in creates the named note (allowFreeURL) with this user as owner.
  const page = await fetch(`${server}/${alias}`, { headers: { Cookie: cookie } });
  if (!page.ok) throw new Error(`CodiMD open ${alias}: HTTP ${page.status}`);

  const status = await writeThroughSocket(server, alias, cookie, markdown, readLastPushed(alias));
  if (status !== 'editedOnWeb') {
    await waitUntilSaved(server, alias, markdown);
    rememberPushed(alias, markdown);
  }
  return { url: `${server}/${alias}`, status };
}
