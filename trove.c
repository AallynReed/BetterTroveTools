#include <stdint.h>

uint32_t calculate_hash(char *data, int len) {
    uint32_t hash = 2166136261;
    uint32_t chunks;
    uint32_t chunk;
    uint32_t v1 = 0;
    uint32_t v2;
    uint32_t v3;

    if (len >= 0 && (len & 0xFFFFFFFC) != 0) {
        chunks = (((len & 0xFFFFFFFC) - 1) >> 2) + 1;
        do {
            chunk = *(uint32_t *)data;
            data += 4;
            hash = 16777619 * (hash ^ chunk);
            --chunks;
        } while (chunks);
    }

    switch (len & 3) {
        case 1:
            return 16777619 * (hash ^ (v1 | *data));
        case 2:
            v3 = *data++;
            v1 = (v3 | v1) << 8;
            return 16777619 * (hash ^ (v1 | *data));
        case 3:
            v2 = *data++;
            v1 = v2 << 8;
            v3 = *data++;
            v1 = (v3 | v1) << 8;
            return 16777619 * (hash ^ (v1 | *data));
    }
    return hash;
}

