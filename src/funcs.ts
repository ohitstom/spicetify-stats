export const updatePageCache = (i: any, callback: Function, activeOption: string, lib: any = false) => {
    let cacheInfo = Spicetify.LocalStorage.get("stats:cache-info");
    if (!cacheInfo) return;

    let cacheInfoArray = JSON.parse(cacheInfo);
    if (!cacheInfoArray[i]) {
        if (!lib) {
            ["short_term", "medium_term", "long_term"].filter(option => option !== activeOption).forEach(option => callback(option, true, false));
        } if (lib === "charts") {
            ["artists", "tracks"].filter(option => option !== activeOption).forEach(option => callback(option, true, false));
        }
        callback(activeOption, true);
        cacheInfoArray[i] = true;
        Spicetify.LocalStorage.set("stats:cache-info", JSON.stringify(cacheInfoArray));
    }
};

type ApiResponse = Record<string, any> | null;

export const apiRequest = async (name: string, url: string, timeout = 5, log = true): Promise<ApiResponse> => {
    try {
        const timeStart = window.performance.now();
        const response = await Spicetify.CosmosAsync.get(url);
        if (log) console.log("stats -", name, "fetch time:", window.performance.now() - timeStart);
        return response;
    } catch (e) {
        if (timeout === 0) {
            console.log("stats -", name, "all requests failed:", e);
            console.log("stats -", name, "giving up");
            return null;
        } else {
            if (timeout === 5) {
                console.log("stats -", name, "request failed:", e);
                console.log("stats -", name, "retrying...");
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            return apiRequest(name, url, timeout - 1);
        }
    }
};


export const fetchAudioFeatures = async (ids: string[]) => {
    const batchSize = 100;
    const batches = [];

    ids = ids.filter(id => id.match(/^[a-zA-Z0-9]{22}$/));

    // Split ids into batches of batchSize
    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        batches.push(batch);
    }

    // Send multiple simultaneous requests using Promise.all()
    const promises = batches.map((batch, index) => {
        const url = `https://api.spotify.com/v1/audio-features?ids=${batch.join(",")}`;
        return apiRequest("audioFeaturesBatch" + index, url, 5, false);
    });

    const responses = await Promise.all(promises);

    // Merge responses from all batches into a single array
    const data = responses.reduce((acc: Record<string, any>[], response) => {
        if (!response?.audio_features) return acc; // Skip if response is empty
        return acc.concat(response.audio_features);
    }, []);

    return data;
};

export const fetchTopAlbums = async (albums: Record<string, number>) => {

    let album_keys = Object.keys(albums)
        .filter(id => id.match(/^[a-zA-Z0-9]{22}$/))
        .sort((a, b) => albums[b] - albums[a])
        .slice(0, 100);
    
    let release_years: Record<string, number> = {};
    let total_album_tracks = 0;
    
    let top_albums: any[] = await Promise.all(album_keys.map(async (albumID: string) => {
        let albumMeta;
        try {
            albumMeta = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getAlbum, {
                uri: `spotify:album:${albumID}`,
                locale: "en",
                offset: 0,
                limit: 50,
            });
            if (!albumMeta?.data?.albumUnion?.name) throw new Error("Invalid URI");
        } catch (e) {
            console.error("stats - album metadata request failed:", e);
            return null;
        }
    
        const releaseYear: string = albumMeta.data.albumUnion.date.isoString.slice(0, 4);

        release_years[releaseYear] = (release_years[releaseYear] || 0) + albums[albumID];
        total_album_tracks += albums[albumID];
        
        return({
            name: albumMeta.data.albumUnion.name,
            uri: albumMeta.data.albumUnion.uri,
            image: albumMeta.data.albumUnion.coverArt.sources[0]?.url || "https://commons.wikimedia.org/wiki/File:Black_square.jpg",
            freq: albums[albumID],
        });
    }));

    top_albums = top_albums.filter(el => el != null).slice(0,10);
    return [top_albums, Object.entries(release_years), total_album_tracks];
};


export const fetchTopArtists = async (artists: Record<string, number>) => {
    if (Object.keys(artists).length === 0) return [[], [], 0];

    let artist_keys: any[] = Object.keys(artists)
        .filter(id => id.match(/^[a-zA-Z0-9]{22}$/))
        .sort((a, b) => artists[b] - artists[a])
        .slice(0, 50);

    let genres: Record<string, number> = {};
    let total_genre_tracks = 0;

    const artistsMeta = await apiRequest("artistsMetadata", `https://api.spotify.com/v1/artists?ids=${artist_keys.join(",")}`);

    let top_artists: any[] = artistsMeta?.artists?.map((artist: any) => {
        if (!artist) return null;

        artist.genres.forEach((genre: string) => {
            genres[genre] = (genres[genre] || 0) + artists[artist.id];
        });
        total_genre_tracks += artists[artist.id];

        return ({
            name: artist.name,
            uri: artist.uri,
            image: artist.images[2]?.url || "https://commons.wikimedia.org/wiki/File:Black_square.jpg",
            freq: artists[artist.id],
        });           
    })

    top_artists = top_artists.filter(el => el != null).slice(0,10);
    const top_genres = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return [top_artists, top_genres, total_genre_tracks];
};

function filterLink(str: string): string {
    const normalizedStr = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return normalizedStr.replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&()*+,;= ]/g, "").replace(/ /g, "+");
}

export const convertToSpotify = async (data: any[], type: string) => {
    return await Promise.all(
        data.map(async (item: any) => {
            if (type === "artists") {
                const spotifyItem = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/search?q=${filterLink(item.name)}&type=artist`).then(
                    (res: any) => res.artists?.items[0]
                );
                if (!spotifyItem) {
                    console.log(`https://api.spotify.com/v1/search?q=${filterLink(item.name)}&type=artist`);
                    return {
                        name: item.name,
                        image: item.image[0]["#text"],
                        uri: item.url,
                        id: item.mbid,
                    };
                };
                return {
                    name: item.name,
                    image: spotifyItem.images[0].url,
                    uri: spotifyItem.uri,
                    id: spotifyItem.id,
                    genres: spotifyItem.genres,
                };
            }

            if (type === "albums") {
                const spotifyItem = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/search?q=${filterLink(item.name)}+artist:${filterLink(item.artist.name)}&type=album`).then(
                    (res: any) => res.albums?.items[0]
                );
                if (!spotifyItem) {
                    console.log(`https://api.spotify.com/v1/search?q=${filterLink(item.name)}+artist:${filterLink(item.artist.name)}&type=album`);
                    return {
                        name: item.name,
                        image: item.image[2]["#text"],
                        uri: item.url,
                        id: item.mbid,
                    };
                };
                return {
                    name: item.name,
                    image: spotifyItem.images[0].url,
                    uri: spotifyItem.uri,
                    id: spotifyItem.id,
                };
            };

            // type === "track"
            const spotifyItem = await Spicetify.CosmosAsync.get(
                `https://api.spotify.com/v1/search?q=track:${filterLink(item.name)}+artist:${filterLink(item.artist.name)}&type=track`
            ).then((res: any) => res.tracks?.items[0]);
            if (!spotifyItem) {
                console.log(`https://api.spotify.com/v1/search?q=track:${filterLink(item.name)}+artist:${filterLink(item.artist.name)}&type=track`);
                return {
                    name: item.name,
                    image: item.image[0]["#text"],
                    uri: item.url,
                    artists: [{ name: item.artist.name, uri: item.artist.url }],
                    duration: 0,
                    album: "N/A",
                    popularity: 0,
                    explicit: false,
                    album_uri: item.url,
                };
            }
            return {
                name: item.name,
                image: spotifyItem.album.images[0].url,
                uri: spotifyItem.uri,
                id: spotifyItem.id,
                artists: spotifyItem.artists.map((artist: any) => ({ name: artist.name, uri: artist.uri })),
                duration: spotifyItem.duration_ms,
                album: spotifyItem.album.name,
                popularity: spotifyItem.popularity,
                explicit: spotifyItem.explicit,
                album_uri: spotifyItem.album.uri,
                release_year: spotifyItem.album.release_date.slice(0, 4),
            };
        })
    );
}

export const checkLiked = async (tracks: string[]) => {
    const nullIndexes: number[] = [];
    tracks.forEach((track, index) => {
        if (track === null) {
            nullIndexes.push(index);
        }
    });

    const apiResponse = (await apiRequest("checkLiked", `https://api.spotify.com/v1/me/tracks/contains?ids=${tracks.filter(e => e).join(",")}`)) as any;

    const response = [];
    let nullIndexesIndex = 0;

    for (let i = 0; i < tracks.length; i++) {
        if (nullIndexes.includes(i)) {
            // Insert false value at the original position of null
            response.push(false);
        } else {
            // Copy the value from the API response
            response.push(apiResponse[nullIndexesIndex]);
            nullIndexesIndex++;
        }
    }

    return response;
};

// taken from shuffle+ extension
export async function queue(list, context = null) {
    // Delimits the end of our list, as Spotify may add new context tracks to the queue
    list.push("spotify:delimiter");

    const { _queue, _client } = Spicetify.Platform.PlayerAPI._queue;
    const { prevTracks, queueRevision } = _queue;

    // Format tracks with default values
    const nextTracks = list.map(uri => ({
        contextTrack: {
            uri,
            uid: "",
            metadata: {
                is_queued: "false"
            }
        },
        removed: [],
        blocked: [],
        provider: "context"
    }));

    // Lowest level setQueue method from vendor~xpui.js
    _client.setQueue({
        nextTracks,
        prevTracks,
        queueRevision
    });

    if (context) {
        const { sessionId } = Spicetify.Platform.PlayerAPI.getState();
        Spicetify.Platform.PlayerAPI.updateContext(sessionId, { uri: `spotify:user:${Spicetify.Platform.LibraryAPI._currentUsername}:top:tracks`, url: "" });
    }

    Spicetify.Player.next();
}