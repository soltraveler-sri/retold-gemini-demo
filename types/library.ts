export interface Photo {
  id: string;
  src: string;
  timestamp: string;
  alt: string;
}

export interface Collection {
  id: string;
  title: string;
  photos: readonly Photo[];
}
