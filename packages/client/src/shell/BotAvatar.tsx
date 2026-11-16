import { Bot, Search, Wrench } from "lucide-react";
import type { BotRecord } from "@dsh-fusion/core";

export function BotAvatar({ bot, large = false }: { bot: BotRecord; large?: boolean }) {
  const Icon = bot.id === "search" ? Search : bot.id === "executor" ? Wrench : Bot;
  return (
    <span className={"fusion-avatar" + (large ? " large" : "") + " tone-" + bot.id} aria-hidden="true">
      <Icon size={large ? 24 : 14} strokeWidth={2.1} />
    </span>
  );
}
