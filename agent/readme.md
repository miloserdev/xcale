-lcurl -ljansson -lcrypto -lsensors

apt-get install libcurl-devel libssl-devel libsensors-devel libjansson-devel

## Running as a service

```
install -d /opt/agent
install -m 755 xcale-agent /opt/agent/xcale-agent
install -m 600 xcale-agent.env /etc/xcale-agent.env   # then edit URL, cluster and token
install -m 644 xcale-agent.service /etc/systemd/system/xcale-agent.service
systemctl daemon-reload
systemctl enable --now xcale-agent
journalctl -u xcale-agent -f
```

The unit reads every setting from `/etc/xcale-agent.env` (`XCALE_URL`, `XCALE_CLUSTER`,
`XCALE_TOKEN`, `XCALE_ROOT`, `XCALE_NODE`, `XCALE_INSECURE`, `XCALE_CACERT`), so the token
does not show up in `ps`. After a change of the file: `systemctl restart xcale-agent`.
