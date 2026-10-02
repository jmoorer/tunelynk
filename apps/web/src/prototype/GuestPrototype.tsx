// PROTOTYPE (issue #10 slice D UI spike): three variants of the guest flow on
// `/`, switchable via ?variant=A|B|C (add &fast for 4x faster timing).
// Uses a real captured run (fixture.json) with real artwork and 30 s Apple
// previews; no API calls. Throwaway: lives on branch prototype/10-guest-ui.
import { useState } from "react";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { stageLabel, usePreviewPlayer, useSimulatedRun } from "./sim";
import * as A from "./VariantA";
import * as B from "./VariantB";
import * as C from "./VariantC";

const VARIANTS = [
  { key: "A", name: A.name, Component: A.VariantA },
  { key: "B", name: B.name, Component: B.VariantB },
  { key: "C", name: C.name, Component: C.VariantC },
];

export function GuestPrototype() {
  const [variant, setVariant] = useState(
    () => new URLSearchParams(window.location.search).get("variant") ?? "A",
  );
  const sim = useSimulatedRun();
  const player = usePreviewPlayer();
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0];

  const change = (key: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("variant", key);
    window.history.replaceState(null, "", `?${params}`);
    setVariant(key);
  };

  if (!current) return null;
  const { Component } = current;
  const status = `${sim.phase}${sim.running ? ` · ${sim.elapsed}s` : ""}${player.current ? ` · ▶ ${player.current.title}` : ""}`;

  return (
    <>
      <Component key={current.key} sim={sim} player={player} />
      <PrototypeSwitcher
        variants={VARIANTS.map(({ key, name }) => ({ key, name }))}
        current={current.key}
        status={status || stageLabel.idle}
        onChange={change}
      />
    </>
  );
}
