import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";

/** Whether this server lets players make Overworld games (MARINARA_OVERWORLD_GAMES); locked until it says so. */
export function useOverworldGamesEnabled() {
  const query = useQuery({
    queryKey: ["game", "overworld-enabled"],
    queryFn: async () => (await api.get<{ enabled: boolean }>("/game/overworld")).enabled === true,
    staleTime: 60_000,
  });
  return query.data === true;
}
