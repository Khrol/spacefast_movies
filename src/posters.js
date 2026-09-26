export function posterPath(movie) {
  const provider = movie.kinopoisk_id && movie.poster_url ? 'kinopoisk' : movie.tmdb_id && movie.poster_path ? 'tmdb' : '';
  const id = Number(movie[`${provider}_id`]);
  return provider && Number.isSafeInteger(id) && id > 0 ? `/api/posters/${provider}/${id}` : '';
}
