import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-[14px]">
      <div className="font-mono text-[12px] text-muted-foreground">404</div>
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <Link href="/" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        Back to events
      </Link>
    </div>
  );
}
