"use client";

// Root-level error boundary. Replaces the whole document when the root layout
// itself throws during render, so it must ship its own <html>/<body> and cannot
// rely on globals.css — styling is inline. Closes the React-render error
// reporting gap by forwarding to Sentry.
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "5rem 1rem",
          textAlign: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#faf7f2",
          color: "#1c1917",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "0.75rem",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#a8a29e",
          }}
        >
          Something went wrong
        </p>
        <h1
          style={{
            margin: "0.75rem 0 0",
            fontSize: "2.25rem",
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          Shezmin hit an unexpected error
        </h1>
        <p
          style={{
            margin: "1rem 0 0",
            maxWidth: "28rem",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            color: "#57534e",
          }}
        >
          Our team has been notified. Please try again in a moment.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "2rem",
            border: "none",
            borderRadius: "0.375rem",
            background: "#b45309",
            color: "#fff",
            padding: "0.625rem 1.25rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
