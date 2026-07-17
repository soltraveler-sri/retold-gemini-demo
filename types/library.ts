export interface Photo {
  id: string;
  file: string;
  src: string;
  timestamp: string;
  alt: string;
}

export interface Collection {
  id: string;
  title: string;
  dateLabel: string;
  promptTemplate: string;
  showcaseFilm: string;
  photos: readonly Photo[];
}
