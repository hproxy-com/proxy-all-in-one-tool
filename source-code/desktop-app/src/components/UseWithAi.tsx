import { useEffect, useState, type JSX, type ReactNode } from "react";
import { copyText, toolCommand } from "../lib/tauri";
import { AgentMark, WorksWith, type MarkName } from "./AgentMarks";
import { BlockTitle, Button, Card, Chip, Icon, InfoTip, PageHead } from "./ui";

/* Use with AI: its own tab, not hidden in Settings, and as easy as it gets:
   it works with every kind of AI agent and shows their logos instead of
   listing names (AgentMarks.tsx, 2026-09-24), and instead of a
   releases page it hands over one text to paste into the agent, which first
   puts HProxy in the agent's memory and then adds it to its settings (one
   step since 2026-10-12; the memory note was a second card).

   Nothing to download: this app is the tool. Started with \`mcp\` it serves
   the tools and opens no window (src-tauri/src/main.rs), and it knows where it
   is, so every text below carries its real path: on Windows its own copy
   outside the install folder, which updates never have to end
   (src-tauri/src/tool.rs). The first block is written
   to the assistant: it adds HProxy to its own settings and remembers how to
   use it. The second is only the memory note. The setups by hand stay one
   click away, as each assistant's own documentation gives them (checked
   2026-09-23; ChatGPT is not among them, its app reaches remote servers only).

   Only things to copy and paste, never a fixed file path to open: no
   button opens another app or a page, and no text holds a file path. The
   command is `hproxy`, because the app puts its tool's folder on the user's
   PATH (src-tauri/src/tool.rs); only where that failed, or the person took it
   off, does the program's full path stand in.

   Since 2026-10-02: still its own tab, since assistants are how many people
   work now, with the paragraphs behind an "i" beside each step rather than
   long sentences on the screen.

   Since 2026-10-10: the two
   texts were two walls of text, 300 px of the first before its button. They
   are two short cards side by side now, each with its first four lines, its
   Copy button and "Show the full text", which unfolds it in place.

   Keep this page, the README's "For AI assistants" and command-line-tool/src/mcp.rs saying
   the same thing. */

const MEMORY = `HProxy (the MCP server "hproxy") handles everything about proxies on this computer:
- proxy_check tests proxy lines in any format and returns the working ones, fastest first.
- proxy_list gives free public proxies; verify=true tests them here first.
- ip_lookup says where an address is.
- proxy_places lists the proxies and groups I saved in the HProxy app; proxy_connect {place: "name"} uses one of them by name.
- proxy_connect starts a local proxy on 127.0.0.1 that forwards through a proxy with its login added; use the http_proxy it returns with curl, a browser or Playwright.
- proxy_status, proxy_new_ip and proxy_disconnect show, change and stop that connection.
- app_open opens the HProxy app for me, or wakes it in the tray (background=true).
Never ask for or repeat proxy passwords. If a call fails, the answer names the right tool or argument: read it and call again.`;

/** The command line in a shell: quoted when the path has spaces. */
const shellArg = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/* One text does it all, memory first (2026-10-12): saving the note to the
   assistant's memory is its first step, never a second copy. The note used
   to close the text as "Then remember this", and a second card offered it on
   its own. */
function setupPrompt(cmd: string): string {
  return `Please set up HProxy for me. It is a local MCP server (stdio) on this computer that checks proxies and connects through them.

1. First, save this note to your permanent memory (your memory, your rules, CLAUDE.md or AGENTS.md), so you know HProxy in every chat from now on:

${MEMORY}

2. Then add this MCP server to your own settings:
  name: hproxy
  command: ${cmd}
  args: mcp

As JSON, for most apps: {"mcpServers": {"hproxy": {"command": ${JSON.stringify(cmd)}, "args": ["mcp"]}}}
VS Code calls the list "servers" and needs "type": "stdio". Codex takes [mcp_servers.hproxy] in ~/.codex/config.toml. Claude Code: claude mcp add hproxy -- ${shellArg(cmd)} mcp

3. Tell me if you need a restart to see it.`;
}

type Setup = { name: string; mark: MarkName; where: ReactNode; snippet: (cmd: string) => string };

const json = (key: string, entry: object) => JSON.stringify({ [key]: { hproxy: entry } }, null, 2);

const SETUPS: Setup[] = [
  { name: "Claude Code", mark: "claude", where: "In a terminal:", snippet: (c) => `claude mcp add hproxy -- ${shellArg(c)} mcp` },
  {
    name: "Claude Desktop",
    mark: "claude",
    where: (
      <>
        Settings, Developer, <b>Edit Config</b> (claude_desktop_config.json), then restart Claude:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Cursor",
    mark: "cursor",
    where: (
      <>
        Paste into <b>~/.cursor/mcp.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "VS Code",
    mark: "vscode",
    where: (
      <>
        Paste into <b>.vscode/mcp.json</b> (VS Code says <b>servers</b>, not mcpServers):
      </>
    ),
    snippet: (c) => json("servers", { type: "stdio", command: c, args: ["mcp"] }),
  },
  {
    name: "Windsurf",
    mark: "windsurf",
    where: (
      <>
        Paste into <b>~/.codeium/windsurf/mcp_config.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Gemini CLI",
    mark: "gemini",
    where: (
      <>
        Paste into <b>~/.gemini/settings.json</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Codex",
    mark: "openai",
    where: (
      <>
        Add to <b>~/.codex/config.toml</b>:
      </>
    ),
    snippet: (c) => `[mcp_servers.hproxy]\ncommand = '${c}'\nargs = ["mcp"]`,
  },
  {
    name: "Zed",
    mark: "zed",
    where: (
      <>
        Zed&rsquo;s settings (<b>zed: open settings file</b>):
      </>
    ),
    snippet: (c) => json("context_servers", { command: c, args: ["mcp"] }),
  },
  {
    name: "Cline",
    mark: "cline",
    where: (
      <>
        Cline, MCP Servers, <b>Configure</b>:
      </>
    ),
    snippet: (c) => json("mcpServers", { command: c, args: ["mcp"] }),
  },
];

/* What the agent can do: every tool command-line-tool/src/mcp.rs serves but
   its own help, in the order a job goes, each with its mark (2026-10-12,
   after a plain list of names and lines). Saved proxies was missing. */
const TOOLS: { name: string; what: string; tool: string; icon: (p: { className?: string }) => JSX.Element }[] = [
  { name: "Check proxies", what: "Tests a list here, the working ones fastest first", tool: "proxy_check", icon: Icon.listCheck },
  { name: "Your proxies", what: "The proxies and groups saved in this app, by name", tool: "proxy_places", icon: Icon.layers },
  { name: "Free proxies", what: "Free public proxies, tested here first", tool: "proxy_list", icon: Icon.globe },
  { name: "Connect through a proxy", what: "A local proxy that adds the login for you", tool: "proxy_connect", icon: Icon.connect },
  { name: "New IP", what: "The next proxy of a group, or a fresh free one", tool: "proxy_new_ip", icon: Icon.refresh },
  { name: "Connection status", what: "What runs, through which proxy, the traffic", tool: "proxy_status", icon: Icon.pulse },
  { name: "IP lookup", what: "Country, city and network of any address", tool: "ip_lookup", icon: Icon.search },
  { name: "Disconnect", what: "Stops the local proxy", tool: "proxy_disconnect", icon: Icon.power },
  { name: "Open HProxy", what: "Opens this app, or wakes it in the tray", tool: "app_open", icon: Icon.laptop },
];

const ASKS = [
  "Check the proxies in proxies.txt and keep the ten fastest elite ones.",
  "Connect me through a free proxy in Germany and tell me which address sites see.",
  "Find me five working SOCKS5 proxies in the United States.",
  "Give me a new IP and tell me where it is.",
];

function Step({ n, title, info, children }: { n: number; title: string; info?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="num w-6 shrink-0 pt-0.5 text-[22px] font-extrabold leading-none text-accent-ink">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[15.5px] font-bold text-ink">
          {title}
          {info && <InfoTip label={title}>{info}</InfoTip>}
        </p>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

/** The text for the agent as a card: its step, Copy, and the text itself on request. */
function CopyCard({
  n,
  title,
  info,
  text,
  id,
  copied,
  onCopy,
}: {
  n: number;
  title: string;
  info: string;
  text: string;
  id: string;
  copied: string | null;
  onCopy: (id: string, t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  return (
    <div className="ux-copycard">
      <p className="head">
        <span className="n num">{n}</span>
        {title}
        <InfoTip label={title}>{info}</InfoTip>
      </p>
      {/* The text itself only on request: the button copies it whole (2026-10-12: less text on the page). */}
      {open && (
        <pre className="num text" data-open>
          {text}
        </pre>
      )}
      <div className="actions">
        <Button variant="solid" onClick={() => onCopy(id, text)}>
          <Icon.copy className="h-4 w-4" />
          {copied === id ? "Copied" : "Copy for my AI agent"}
        </Button>
        <button type="button" className="ux-link" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the text" : `See the text, ${lines} lines`}
        </button>
      </div>
    </div>
  );
}

/** A setup by hand: the snippet and its Copy. */
function Block({ text, id, copied, onCopy }: { text: string; id: string; copied: string | null; onCopy: (id: string, t: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Card tone="sunken" pad="tight">
        <pre className="num max-h-[300px] overflow-auto whitespace-pre-wrap text-[13px] font-semibold leading-relaxed text-ink">{text}</pre>
      </Card>
      <div>
        <Button variant="soft" size="sm" onClick={() => onCopy(id, text)}>
          <Icon.copy className="h-4 w-4" />
          {copied === id ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export default function UseWithAi() {
  const [copied, setCopied] = useState<string | null>(null);
  const [cmd, setCmd] = useState("hproxy");
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    void toolCommand()
      .then((c) => c && setCmd(c))
      .catch(() => {});
  }, []);
  const copy = (id: string, text: string) => {
    void copyText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
  };
  const setup = SETUPS.find((s) => s.name === pick);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card tone="flat" pad="roomy">
          <PageHead
            title="Use with AI"
            info="Your AI agent checks proxies and connects through them, and never sees a password."
            aside={<WorksWith label="Works with every MCP agent" />}
          />

          <div className="mt-7">
            <CopyCard
              n={1}
              title="Copy this into your AI agent"
              info="Paste it into the chat. Your agent first saves HProxy to its memory, so it knows it in every chat, then adds it to its own settings. Some apps need a restart to see it."
              id="prompt"
              text={setupPrompt(cmd)}
              copied={copied}
              onCopy={copy}
            />
          </div>

          <div className="mt-8 flex flex-col gap-8">
            <Step n={2} title="Or set it up yourself">
              <div className="flex flex-wrap gap-1.5">
                {SETUPS.map((s) => (
                  <Chip key={s.name} on={pick === s.name} onClick={() => setPick(pick === s.name ? null : s.name)}>
                    <AgentMark mark={s.mark} size={14} />
                    {s.name}
                  </Chip>
                ))}
              </div>
              {setup && (
                <div key={setup.name} className="rise-in mt-4 flex flex-col gap-3">
                  <p className="max-w-[80ch] text-[14px] font-medium leading-relaxed text-ink-mute">{setup.where}</p>
                  <Block id={setup.name} text={setup.snippet(cmd)} copied={copied} onCopy={copy} />
                </div>
              )}
            </Step>

            <Step n={3} title="Then just ask">
              {/* Quotes, not boxes: a line in our blue beside each. */}
              <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                {ASKS.map((q) => (
                  <p key={q} className="border-l-2 border-[var(--digi)] pl-3 text-[14px] font-medium leading-relaxed text-ink">
                    “{q}”
                  </p>
                ))}
              </div>
            </Step>
          </div>
        </Card>

        <Card tone="flat" pad="roomy">
          <BlockTitle
            name="What your agent can do"
            info={
              <>
                <p>
                  A mistake is answered with the way out: a wrong tool or argument gets the closest real one and every choice, so even a simple agent
                  finds its way.
                </p>
                <p>
                  A connection your agent opens is never hidden: <b className="num">{shellArg(cmd)} status</b> shows it and{" "}
                  <b className="num">{shellArg(cmd)} stop</b> ends it.
                </p>
              </>
            }
          />
          {/* A grid of marks, not a table: each tool's mark in our blue, its name, one line. */}
          <div className="ux-toolgrid mt-5">
            {TOOLS.map((t) => (
              <div key={t.name} className="tool" title={`The tool ${t.tool}`}>
                <t.icon className="mark" />
                <p className="name">{t.name}</p>
                <p className="what">{t.what}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
