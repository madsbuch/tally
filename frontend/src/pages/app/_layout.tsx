import { Outlet, useLocation } from "react-router";
import { Link } from "../../router";

export default function AppLayout() {
  const location = useLocation();

  return (
    <div className="flex flex-col h-svh safe-top">
      {/* Main content */}
      <main className="flex-grow overflow-y-scroll overscroll-none touch-pan-y">
        <div className="container mx-auto px-4">
          <Outlet />
        </div>
      </main>

      {/* Bottom navigation */}
      <nav className="sticky h-24 bottom-0 bg-white border-t border-gray-200 safe-bottom">
        <div className="px-4">
          <div className="flex justify-around items-center py-5">
            {/* Journal */}
            <Link
              to="/app/journal"
              className={`flex flex-col items-center ${
                location.pathname === "/app/journal" || location.pathname.startsWith("/app/journal/")
                  ? "text-forest"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg
                className="w-7 h-7"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
              <span className="text-sm mt-1.5">Journal</span>
            </Link>

            {/* Analytics */}
            <Link
              to="/app/analytics"
              className={`flex flex-col items-center ${
                location.pathname === "/app/analytics"
                  ? "text-forest"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg
                className="w-7 h-7"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
              <span className="text-sm mt-1.5">Analytics</span>
            </Link>

            {/* New */}
            <Link
              to="/app/new"
              className={`flex flex-col items-center ${
                location.pathname === "/app/new"
                  ? "text-forest"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg
                className="w-7 h-7"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              <span className="text-sm mt-1.5">Add</span>
            </Link>

            {/* Autophagy */}
            <Link
              to="/app/autophagy"
              className={`flex flex-col items-center ${
                location.pathname === "/app/autophagy"
                  ? "text-forest"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg
                className="w-7 h-7"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                />
              </svg>
              <span className="text-sm mt-1.5">Autophagy</span>
            </Link>

            {/* Settings */}
            <Link
              to="/app/config"
              className={`flex flex-col items-center ${
                location.pathname === "/app/config"
                  ? "text-forest"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg
                className="w-7 h-7"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span className="text-sm mt-1.5">Config</span>
            </Link>
          </div>
        </div>
      </nav>
    </div>
  );
}
