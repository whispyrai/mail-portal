// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Empty,
	LinkProvider,
	Loader,
	Toasty,
	TooltipProvider,
} from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
} from "react-router";
import { ApiError } from "~/services/api";
import { useBrand } from "~/hooks/useBrand";
import { ServiceWorkerRegistrar } from "~/components/pwa/ServiceWorkerRegistrar";
import { resolveBrand } from "../workers/routes/brand";
import { isQuizEnabled } from "../workers/lib/features";
import type { Route } from "./+types/root";
import "./index.css";

// BRAND selects the active brand (WISER-238). Resolved server-side so the
// <html data-brand> below is set before first paint — no flash of the wrong
// palette. Mirrors the static data-mode="light". resolveBrand fails safe to
// whispyr for an unset/unknown value. quizEnabled is SSR'd the same way so the
// Header's Quizzes button never flashes on before a brand that omits it (WISER-239).
export async function loader({ context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const b = resolveBrand(env.BRAND);
	return {
		brand: b.id,
		name: b.name,
		appName: b.appName,
		favicon: b.favicon,
		appleTouchIcon: b.appleTouchIcon,
		legacyFavicon: b.legacyFavicon,
		legacyFaviconType: b.legacyFaviconType,
		legacyFaviconSizes: b.legacyFaviconSizes,
		quizEnabled: isQuizEnabled(env.FEATURES, b.id),
		themeColor: b.themeColor,
	};
}

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

const KumoLink = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return (
			<RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
		);
	}
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	const {
		brand,
		appName,
		favicon,
		appleTouchIcon,
		legacyFavicon,
		legacyFaviconType,
		legacyFaviconSizes,
		themeColor,
	} = useBrand();
	return (
		<html lang="en" data-mode="light" data-theme="kumo" data-brand={brand}>
			<head>
				<meta charSet="UTF-8" />
				{/* PWA: installable + home-screen behaviour (WISER-240). */}
				<link rel="manifest" href="/manifest.webmanifest" />
				<meta name="theme-color" content={themeColor} />
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-status-bar-style" content="default" />
				<meta name="apple-mobile-web-app-title" content={appName} />
				<link rel="apple-touch-icon" href={appleTouchIcon} />
				<link
					rel="icon"
					type="image/svg+xml"
					href={favicon}
				/>
				<link
					rel="icon"
					type={legacyFaviconType}
					href={legacyFavicon}
					sizes={legacyFaviconSizes}
				/>
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{appName}</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-kumo-recessed text-kumo-default antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<ServiceWorkerRegistrar />
						<Outlet />
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={status === 404 ? "404 — Page not found" : title}
				description={description}
				contents={
					<Button
						variant="primary"
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}
