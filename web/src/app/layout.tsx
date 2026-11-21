import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flight Booking Agent",
  description: "Local-first tool-calling agent that books flights with transactional integrity",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
