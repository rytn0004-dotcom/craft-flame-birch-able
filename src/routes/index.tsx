import { createFileRoute } from "@tanstack/react-router";
import { FoxTD } from "@/game/FoxTD";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <FoxTD />;
}
