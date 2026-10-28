type Named = { key: string; nodeId: string; id: string; label: string }

// libsensors labels are not unique ("Voltage", "Temperature" for dozens of sensors), the ids
// are. Where a label repeats on a node, the part of the id that tells the sensors apart is
// appended: <chip>_<bus>x<addr>_<subfeature> with the shared leading tokens and the
// "_input" tail removed.
export function sensorNames(sensors: Named[]) {
  const groups = new Map<string, Named[]>()
  for (const s of sensors) {
    const group = groups.get(`${s.nodeId}|${s.label}`) ?? []
    group.push(s)
    groups.set(`${s.nodeId}|${s.label}`, group)
  }

  const names = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length === 1) {
      names.set(group[0].key, group[0].label)
      continue
    }
    const tokens = group.map((s) =>
      s.id.replace(/_(input|average)$/, "").split("_")
    )
    let common = 0
    while (
      tokens.every(
        (t) => common < t.length - 1 && t[common] === tokens[0][common]
      )
    )
      common++
    group.forEach((s, i) =>
      names.set(s.key, `${s.label} · ${tokens[i].slice(common).join("_")}`)
    )
  }
  return names
}
