"use client"

import * as React from "react"

import { ClusterNav } from "@/components/cluster-nav"
import { ClusterSwitcher } from "@/components/cluster-switcher"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: { name: string } }) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ClusterSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <ClusterNav />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
