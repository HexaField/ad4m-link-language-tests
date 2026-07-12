#!/usr/bin/env python3
# Wind-tunnel localhost test relay: accept every well-formed event.
#
# The dockurr/strfry image ships a whitelist write-policy (write-policy.py)
# pre-populated with placeholder pubkeys ("hex-pubkey-1") and IPs
# (1.1.1.1 / 8.8.8.8). Any real templated link-language keypair therefore
# gets its diff-DAG events rejected ("not in whitelist"), so no writes land
# and multi-agent convergence never happens.
#
# A convergence relay bound to 127.0.0.1 has no untrusted writers, so we mount
# this accept-all policy over /app/write-policy.py. strfry speaks the same
# JSONL plugin protocol: read one request per line, emit {"id","action"} for
# every "new" event and stay silent for "lookback".
import sys
import json


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if request.get("type") != "new":
            # "lookback" and any other control types produce no response.
            continue
        event_id = request.get("event", {}).get("id")
        if not event_id:
            continue
        print(
            json.dumps({"id": event_id, "action": "accept"}, separators=(",", ":")),
            end="\n",
            flush=True,
        )


if __name__ == "__main__":
    main()
