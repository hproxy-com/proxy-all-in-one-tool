# HProxy in a container

`ghcr.io/hproxy-com/hproxy` is the hproxy command-line tool as one container image for every Linux
processor it is built for. Docker, Podman, Kubernetes and the clouds pull the right one by
themselves:

| Platform | Machines |
| --- | --- |
| `linux/amd64` | PCs and servers with Intel or AMD processors |
| `linux/arm64` | AWS Graviton and other ARM servers, Docker on Apple Silicon Macs, Raspberry Pi 3, 4 and 5 with a 64-bit system |
| `linux/arm/v7`, `linux/arm/v6` | every Raspberry Pi with a 32-bit system, Pi Zero and Pi 1 included |
| `linux/386` | older 32-bit PCs and thin clients |
| `linux/riscv64` | RISC-V boards and servers |

The image holds one file, the program, and nothing else: no operating system to patch, no shell. It
runs as an unprivileged user. [A workflow in this repository](../.github/workflows/docker-release.yml)
builds it from the files of a [command-line release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases),
each checked against its SHA-256 and its build record first, and proves it on every processor before
it is pushed.

## Try it

```sh
docker run --rm ghcr.io/hproxy-com/hproxy list --country US --limit 5
docker run --rm ghcr.io/hproxy-com/hproxy check 198.51.100.7:8080 user:pass@203.0.113.9:1080
docker run --rm ghcr.io/hproxy-com/hproxy ip 8.8.8.8
```

Every command works this way: `docker run --rm ghcr.io/hproxy-com/hproxy <command>`.
[All the commands](../source-code/README.md#command-line).

## The rotating proxy

`hproxy connect` starts a proxy of your own, HTTP and SOCKS5 on one port, that sends every
connection through your proxies in turn, or through the free HProxy pool. Your software uses it with
no username or password.

Your own proxies, the next one for every connection. Put them in a file, one per line, in any shape
your provider prints (`host:port:user:pass`, `user:pass@host:port`, `http://...`, `socks5://...`):

```sh
docker run -d --name hproxy --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -v "$PWD/proxies.txt:/proxies.txt:ro" \
  ghcr.io/hproxy-com/hproxy connect --file /proxies.txt --rotate every --listen 0.0.0.0:8080 --allow-lan
```

The free pool, with a new exit whenever one stops answering:

```sh
docker run -d --name hproxy --restart unless-stopped -p 127.0.0.1:8080:8080 \
  ghcr.io/hproxy-com/hproxy free --country US --listen 0.0.0.0:8080 --allow-lan
```

Then point your software at `http://127.0.0.1:8080`, or `socks5h://127.0.0.1:8080`:

```sh
curl -x http://127.0.0.1:8080 https://example.com
```

`--rotate every` takes the next proxy for every connection, `every:25` changes every 25
connections, `every:10m` every ten minutes, `random` picks one at random, and `on-failure` stays
with one until it stops answering. Add `-v` to log one line per request (`docker logs hproxy`).
`docker stop hproxy` ends it at once.

Your own scripts switch it when they decide, over plain HTTP on the same port (`on-failure` keeps one
proxy until then): `curl -X POST http://127.0.0.1:8080/hproxy/new-ip` for the next proxy,
`curl http://127.0.0.1:8080/hproxy/status` for the one in use and the counts. Every answer is JSON.
Any language does the same: [examples](../examples/new-ip/).

### Who can reach it

The proxy asks for no password, so anyone who can reach its port can spend your traffic. Inside a
container it has to listen on the container's own network to be reachable at all, and it does that
only with `--allow-lan`. Then `-p 127.0.0.1:8080:8080` publishes the port on this computer's
loopback only, so nothing else can use it. To share it with other machines, publish it on a private
address and let a firewall admit only your own machines. Never publish it on a public address.

## Docker Compose

```yaml
services:
  hproxy:
    image: ghcr.io/hproxy-com/hproxy:0.4.9
    command: connect --file /proxies.txt --rotate every --listen 0.0.0.0:8080 --allow-lan
    volumes:
      - ./proxies.txt:/proxies.txt:ro
    restart: unless-stopped

  app:
    image: your-app
    environment:
      HTTP_PROXY: http://hproxy:8080
      HTTPS_PROXY: http://hproxy:8080
    depends_on: [hproxy]
```

The services of one Compose project reach it by name, and since it publishes no port, nothing
outside them can.

## Beside your app on 127.0.0.1: Kubernetes, Amazon EKS, ECS and Fargate

The containers of one Kubernetes pod, and of one ECS task in `awsvpc` mode (every Fargate task),
share one network. The rotator can sit beside your app on `127.0.0.1:8080`, its default, where
nothing outside the pod or the task can reach it, and it needs no `--allow-lan` there.

Kubernetes and Amazon EKS, with the list in a Secret
(`kubectl create secret generic hproxy-proxies --from-file=proxies.txt`):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: scraper
spec:
  containers:
    - name: app
      image: your-app
      env:
        - name: HTTPS_PROXY
          value: http://127.0.0.1:8080
    - name: hproxy
      image: ghcr.io/hproxy-com/hproxy:0.4.9
      args: ["connect", "--file", "/etc/hproxy/proxies.txt", "--rotate", "every"]
      volumeMounts:
        - name: proxies
          mountPath: /etc/hproxy
          readOnly: true
  volumes:
    - name: proxies
      secret:
        secretName: hproxy-proxies
```

Amazon ECS and Fargate, in the task definition's `containerDefinitions`, beside your app, whose
`HTTPS_PROXY` is then `http://127.0.0.1:8080`. Keep your proxy's line in AWS Secrets Manager and
hand it over as `HPROXY_PROXY`: `connect` takes it from there when its command names no proxy, so the
password never appears in the task definition.

```json
{
  "name": "hproxy",
  "image": "ghcr.io/hproxy-com/hproxy:0.4.9",
  "essential": true,
  "command": ["connect"],
  "secrets": [{ "name": "HPROXY_PROXY", "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:<name>" }]
}
```

The free HProxy pool needs no secret: `"command": ["free", "--country", "US"]`.

A whole list works the same way with `HPROXY_PROXY_FILE`, the path of a mounted file. Your app,
beside it on `127.0.0.1`, can switch it with `POST http://127.0.0.1:8080/hproxy/new-ip`. A task on
Graviton (`"runtimePlatform": {"cpuArchitecture": "ARM64"}`) pulls the arm64 image by itself.

On an Amazon EC2 instance, or any Linux server without containers, one line installs the same
program, on Intel, AMD and Graviton alike:

```sh
curl -fsSL https://hproxy.com/install.sh | sh
```

## NAS and home servers

Synology (Container Manager), QNAP (Container Station), Unraid, TrueNAS SCALE, or Docker on a
Raspberry Pi: create a container from `ghcr.io/hproxy-com/hproxy:latest` with your list mounted at
`/proxies.txt` and the command `connect --file /proxies.txt --listen 0.0.0.0:8080 --allow-lan`
(`free --listen 0.0.0.0:8080 --allow-lan` for the free pool), map port 8080, and keep that port
inside your home network. A [Flipper Zero](https://github.com/hproxy-com/flipper-zero-app) on the same
network can then switch it to the next proxy.

## For AI assistants

An assistant that starts its MCP servers with Docker runs this one the same way:

```json
{
  "mcpServers": {
    "hproxy": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "ghcr.io/hproxy-com/hproxy", "mcp"]
    }
  }
}
```

`-i` keeps the input open, which is the line the assistant talks to the server on. Checking, the
free list and the lookups work as they do outside a container; a connection it starts lives inside
the container.

## Details

- **Tags.** A version tag (`0.4.9`) never changes once it is pushed. `latest` follows the newest
  release. Pin a version where it matters, and pull the next one when it is out.
- **Where it came from.** `gh attestation verify oci://ghcr.io/hproxy-com/hproxy:0.4.9 --owner hproxy-com`
  checks the image's build record: this repository's workflow built it.
- **User and home.** It runs as user 65532, with its home in `/home/hproxy`. A background connection
  (`docker exec hproxy hproxy connect ... --background`, then `hproxy status` and `hproxy stop` the
  same way) keeps its entry there.
- **Switched off in the image.** The daily update notice (`HPROXY_NO_UPDATE_CHECK=1`), since here the
  update is `docker pull`. The usage question (`HPROXY_NO_USAGE=1`), which a container thrown away
  after each run would ask every time. To take part in the anonymous usage counts
  ([what they hold](https://hproxy.com/privacy)), keep the home in a volume and answer once:
  `docker run --rm -it -e HPROXY_NO_USAGE=0 -v hproxy:/home/hproxy ghcr.io/hproxy-com/hproxy usage on`,
  then run it with the same `-e` and `-v`.
- **Stopping.** `docker stop` and Ctrl+C end every command at once and cleanly, also as process 1,
  where the kernel drops every signal a program has no handler for: hproxy handles SIGINT and
  SIGTERM itself. With 0.4.8, run the commands other than `connect` and `free` with `--init`.
- **Podman.** The same commands, with `podman` in place of `docker`.
