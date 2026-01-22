import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet } from "react-router";
import { useEffect } from "react";
import { processPendingAIJobs } from "../lib/ai-processor";

export default function App() {
  const queryClient = new QueryClient();

  // Process pending AI jobs on app startup
  useEffect(() => {
    processPendingAIJobs().catch((err) => {
      console.error("Failed to process pending AI jobs:", err);
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
