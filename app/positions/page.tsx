import { db } from "@/lib/db";
import AutoRefresh from "../components/AutoRefresh";
import { Empty, Panel } from "../components/ui";
import { PositionsTable } from "./table";

export const dynamic = "force-dynamic";

export default async function Positions() {
  const [open, closed] = await Promise.all([
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    db.position.findMany({ where: { status: "CLOSED" }, orderBy: { closedAt: "desc" }, take: 100 }),
  ]);
  return (
    <>
      <AutoRefresh />
      <Panel title={`Open (${open.length})`}>{open.length ? <PositionsTable rows={open} /> : <Empty>None open.</Empty>}</Panel>
      <Panel title="Closed (last 100)">{closed.length ? <PositionsTable rows={closed} /> : <Empty>No closed trades yet.</Empty>}</Panel>
    </>
  );
}
