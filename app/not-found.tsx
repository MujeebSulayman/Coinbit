import { Compass } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-24 text-center">
      <div className="grid size-11 place-items-center rounded-xl border border-line bg-raised text-mute">
        <Compass size={20} />
      </div>
      <h1 className="text-[18px] font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-sm text-[13px] text-faint">That page or trade doesn't exist. It may have been removed, or the link is wrong.</p>
      <div className="mt-2 flex gap-2">
        <Link href="/" className="btn btn-primary">
          Overview
        </Link>
        <Link href="/positions" className="btn">
          Positions
        </Link>
      </div>
    </div>
  );
}
