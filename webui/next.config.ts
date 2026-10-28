import type { NextConfig } from "next"

const nextConfig: NextConfig = {
    // addresses the dev server is opened from; others load the page but cannot hydrate it
    allowedDevOrigins: ["100.64.11.4", "100.64.12.2", "10.112.130.29"],
}

export default nextConfig
