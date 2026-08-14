import { useEffect } from "react";

/* Sets the browser tab title while a route is mounted, and puts back
   whatever was there when it unmounts.

   The restore matters because this is a single-page app: without it,
   navigating from a lane's overhead to its kiosk would leave the tab still
   claiming to be the overhead. In the real deployment each device sits on
   one URL forever and never navigates, but the dev launcher at `/` does,
   and a tab that lies about what it's showing is exactly the kind of thing
   that wastes ten minutes when several are open at once.

   Belongs in route containers (DisplayLanePage and friends), not in the
   presentational components -- changing the document title is a side
   effect on the page, and those are meant to be pure functions of props. */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}
