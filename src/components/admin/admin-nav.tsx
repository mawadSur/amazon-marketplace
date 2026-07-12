"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/sellers", label: "Sellers" },
  { href: "/admin/listings", label: "Listings" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/shipments", label: "Shipments" },
  { href: "/admin/payouts", label: "Payouts" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/analytics", label: "Analytics" },
];

export function AdminNav({ variant }: { variant: "desktop" | "mobile" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (variant === "desktop") {
    return (
      <nav className="flex flex-col gap-1">
        {items.map((it) => (
          <NavLink key={it.href} href={it.href} label={it.label} pathname={pathname} />
        ))}
      </nav>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Toggle navigation"
        className="rounded-md border border-border px-3 py-1.5 text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        Menu
      </button>
      {open && (
        <div className="fixed inset-x-0 top-[56px] z-30 border-b border-border bg-background shadow-md md:hidden">
          <nav className="flex flex-col p-2">
            {items.map((it) => (
              <NavLink
                key={it.href}
                href={it.href}
                label={it.label}
                pathname={pathname}
                onClick={() => setOpen(false)}
              />
            ))}
          </nav>
        </div>
      )}
    </>
  );
}

function NavLink({
  href,
  label,
  pathname,
  onClick,
}: {
  href: string;
  label: string;
  pathname: string;
  onClick?: () => void;
}) {
  // /admin must only be "active" on exact match; otherwise every subpath matches.
  const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-medium transition",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}
