import { LibraryView } from "./library-view";
import { loadCollections } from "../lib/collections";

export default function Home() {
  return <LibraryView collections={loadCollections()} />;
}
