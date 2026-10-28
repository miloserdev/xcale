"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  FlaskConicalIcon,
  FileCodeIcon,
  LayoutDashboardIcon,
  ServerIcon,
  Settings2Icon,
} from "lucide-react"

import { useCluster } from "@/components/cluster-provider"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function ClusterNav() {
  const { activeCluster } = useCluster()
  const pathname = usePathname()
  const base = `/${activeCluster.id}`
  const items = [
    {
      title: "Overview",
      href: base,
      icon: <LayoutDashboardIcon />,
      exact: true,
    },
    { title: "Nodes", href: `${base}/nodes`, icon: <ServerIcon /> },
    { title: "Tests", href: `${base}/tests`, icon: <FlaskConicalIcon /> },
    { title: "Scripts", href: `${base}/scripts`, icon: <FileCodeIcon /> },
    { title: "Settings", href: `${base}/settings`, icon: <Settings2Icon /> },
  ]

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{activeCluster.name}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              tooltip={item.title}
              isActive={
                item.exact
                  ? pathname === item.href
                  : pathname.startsWith(item.href)
              }
              render={<Link href={item.href} />}
            >
              {item.icon}
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
