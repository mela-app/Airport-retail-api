#!/usr/bin/env bash
# Deploys the backend image to the VPS over SSH (the deploy job of .github/workflows/ci.yml; also usable by hand):
# copies deploy/compose.yaml to /opt/arm/api, records the image to run, pulls it with a short-lived registry
# token and restarts the stack, waiting until every container is healthy.
#
#   VPS_HOST, VPS_USER     the server and the SSH user (member of the docker group)
#   SSH_KEY_FILE           private key of the deploy user
#   KNOWN_HOSTS_FILE       the server's pinned host key (ssh-keyscan output, checked strictly)
#   IMAGE                  ghcr.io/<owner>/<repo>@sha256:...
#   REGISTRY_USER, REGISTRY_TOKEN   GHCR credentials allowed to pull the image (the job's GITHUB_TOKEN)
set -euo pipefail

DIR=/opt/arm/api
VAR=API_IMAGE
target="${VPS_USER}@${VPS_HOST}"
ssh_opts=(-i "$SSH_KEY_FILE" -o "UserKnownHostsFile=$KNOWN_HOSTS_FILE" -o StrictHostKeyChecking=yes -o BatchMode=yes)
remote() { ssh "${ssh_opts[@]}" "$target" "$@"; }

case "$IMAGE" in
  ghcr.io/*@sha256:*) ;;
  *) echo "IMAGE must be a ghcr.io image pinned by digest" >&2; exit 1 ;;
esac

# The shared network between the frontend and backend stacks, the folder and its settings file (.env holds the
# server's own values such as POSTGRES_PASSWORD and PUBLIC_BASE_URL; it is created empty on the first deploy).
remote "docker network inspect arm-edge >/dev/null 2>&1 || docker network create arm-edge >/dev/null;
  mkdir -p $DIR && cd $DIR && touch .env && chmod 600 .env"
scp -q "${ssh_opts[@]}" deploy/compose.yaml "$target:$DIR/compose.yaml"
remote "printf '%s=%s\n' $VAR '$IMAGE' > $DIR/.image"

printf '%s' "$REGISTRY_TOKEN" | remote "docker login ghcr.io -u '$REGISTRY_USER' --password-stdin >/dev/null"
remote "cd $DIR && docker compose --env-file .env --env-file .image pull --quiet; pulled=\$?;
  docker logout ghcr.io >/dev/null; [ \$pulled -eq 0 ] || exit \$pulled;
  docker compose --env-file .env --env-file .image up -d --remove-orphans --wait --wait-timeout 300 &&
  docker image prune -f >/dev/null"
echo "deployed $IMAGE"
