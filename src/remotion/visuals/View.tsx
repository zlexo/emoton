import type { Visual } from "../../../schema/storyboard.ts";
import type { DiagramScene } from "../../core/diagram.ts";
import { Title } from "./Title.tsx";
import { Bullets } from "./Bullets.tsx";
import { Equation } from "./Equation.tsx";
import { Code } from "./Code.tsx";
import { Diagram } from "./Diagram.tsx";
import { Sequence } from "./Sequence.tsx";
import { Graph } from "./Graph.tsx";
import { Venn } from "./Venn.tsx";

/** One visual on the 1920 x 1080 stage; a diagram that builds over beats draws from its timeline. */
export const VisualView: React.FC<{ v: Visual; t: number; at: number[]; diagram?: { scenes: DiagramScene[]; times: number[][] } }> = ({ v, t, at, diagram }) => {
  if (diagram) return <Diagram tl={diagram} t={t} />;
  switch (v.type) {
    case "title": return <Title v={v} t={t} at={at} />;
    case "bullets": return <Bullets v={v} t={t} at={at} />;
    case "equation": return <Equation v={v} t={t} at={at} />;
    case "code": return <Code v={v} t={t} at={at} />;
    case "sequence": return <Sequence v={v} t={t} at={at} />;
    case "graph": return <Graph v={v} t={t} at={at} />;
    case "venn": return <Venn v={v} t={t} at={at} />;
    case "diagram": return null;
  }
};

