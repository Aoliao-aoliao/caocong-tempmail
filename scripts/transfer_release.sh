#!/usr/bin/env bash
# Sourced by the runner after strict host-key/password setup; never prints secrets.
transfer_release() {
  local remote="/opt/nodemail/.deploy/incoming/$GITHUB_SHA"
  [[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1
  local digest
  digest=$(sha256sum release/nodemail-image.tar.gz)
  digest=${digest%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  # The artifact manifest names a file relative to release/, not the checkout.
  (cd release && sha256sum -c nodemail-image.tar.gz.sha256) || return 1
  local partdir="$remote/parts-$digest" localparts="$ssh_dir/parts" part name part_hash attempt copied
  mkdir -p "$localparts"
  if sshpass -e ssh "${opts[@]}" -p "$SSH_PORT" "$target" "test -f '$remote/nodemail-image.tar.gz' && printf '%s\n' '$digest  $remote/nodemail-image.tar.gz' | sha256sum -c --status"; then
    echo 'Verified existing complete release archive'
  else
    split -b 4M -d -a 6 release/nodemail-image.tar.gz "$localparts/part-"
    sshpass -e ssh "${opts[@]}" -p "$SSH_PORT" "$target" "mkdir -p '$partdir'" || return 1
    for part in "$localparts"/part-*; do
      name=${part##*/}
      part_hash=$(sha256sum "$part"); part_hash=${part_hash%% *}
      copied=false
      for ((attempt=1; attempt<=3; attempt++)); do
        if sshpass -e ssh "${opts[@]}" -p "$SSH_PORT" "$target" "test -f '$partdir/$name' && printf '%s\n' '$part_hash  $partdir/$name' | sha256sum -c --status"; then
          copied=true; break
        fi
        echo "Uploading release $name (attempt $attempt)"
        if sshpass -e scp "${opts[@]}" -P "$SSH_PORT" "$part" "$target:$partdir/$name" &&
           sshpass -e ssh "${opts[@]}" -p "$SSH_PORT" "$target" "printf '%s\n' '$part_hash  $partdir/$name' | sha256sum -c --status"; then
          copied=true; break
        fi
      done
      [[ "$copied" = true ]] || { echo 'Release part transfer failed; verified parts retained for retry' >&2; return 1; }
    done
    sshpass -e ssh "${opts[@]}" -p "$SSH_PORT" "$target" "cat '$partdir'/part-* > '$remote/nodemail-image.tar.gz.tmp' && printf '%s\n' '$digest  $remote/nodemail-image.tar.gz.tmp' | sha256sum -c --status && mv '$remote/nodemail-image.tar.gz.tmp' '$remote/nodemail-image.tar.gz' && rm -rf -- '$partdir'" || return 1
  fi
  sshpass -e scp "${opts[@]}" -P "$SSH_PORT" release/nodemail-image.tar.gz.sha256 scripts/deploy.sh scripts/deploy_preflight.py scripts/snapshot_rollback.py scripts/cleanup_releases.py scripts/site_profile.py "$target:$remote/" || return 1
  echo 'Release archive and deployment helpers transferred and verified'
}
