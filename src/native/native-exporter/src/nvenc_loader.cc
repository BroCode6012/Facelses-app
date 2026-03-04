#include "nvenc_loader.h"
#include <cstring>
#include <string>
#include <cstdio>

namespace nativeexporter {

static HMODULE s_nvencDll = nullptr;
static NV_ENCODE_API_FUNCTION_LIST s_funcList = {};
static NvEncodeAPICreateInstance_t s_createInstance = nullptr;
static uint32_t s_maxApiVersion = 0;

bool loadNvenc() {
    if (s_nvencDll) return true; // already loaded

    // Try default search path first
    s_nvencDll = LoadLibraryW(L"nvEncodeAPI64.dll");
    if (!s_nvencDll) {
        fprintf(stderr, "[NVENC] LoadLibrary default failed, err=%lu\n", GetLastError());
    }

    // Fallback: explicit System32 path (Electron may restrict DLL search)
    if (!s_nvencDll) {
        wchar_t sysDir[MAX_PATH] = {};
        GetSystemDirectoryW(sysDir, MAX_PATH);
        std::wstring fullPath = std::wstring(sysDir) + L"\\nvEncodeAPI64.dll";
        s_nvencDll = LoadLibraryW(fullPath.c_str());
        if (!s_nvencDll) {
            fprintf(stderr, "[NVENC] LoadLibrary System32 failed, err=%lu\n", GetLastError());
        }
    }

    // Fallback: DriverStore path
    if (!s_nvencDll) {
        // Search for it in the NVIDIA DriverStore
        wchar_t sysDir[MAX_PATH] = {};
        GetSystemDirectoryW(sysDir, MAX_PATH);
        std::wstring driverStore = std::wstring(sysDir) + L"\\DriverStore\\FileRepository";
        WIN32_FIND_DATAW fd;
        std::wstring pattern = driverStore + L"\\nvlt.inf_*\\nvEncodeAPI64.dll";
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind != INVALID_HANDLE_VALUE) {
            // Found via glob — but FindFirstFile doesn't expand directory wildcards
            // So we need to enumerate directories
            FindClose(hFind);
            std::wstring dirPattern = driverStore + L"\\nvlt.inf_*";
            hFind = FindFirstFileW(dirPattern.c_str(), &fd);
            if (hFind != INVALID_HANDLE_VALUE) {
                do {
                    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                        std::wstring candidate = driverStore + L"\\" + fd.cFileName + L"\\nvEncodeAPI64.dll";
                        s_nvencDll = LoadLibraryW(candidate.c_str());
                        if (s_nvencDll) break;
                    }
                } while (FindNextFileW(hFind, &fd));
                FindClose(hFind);
            }
        }
    }

    if (!s_nvencDll) return false;

    s_createInstance = (NvEncodeAPICreateInstance_t)
        GetProcAddress(s_nvencDll, "NvEncodeAPICreateInstance");
    if (!s_createInstance) {
        fprintf(stderr, "[NVENC] GetProcAddress(NvEncodeAPICreateInstance) failed\n");
        FreeLibrary(s_nvencDll);
        s_nvencDll = nullptr;
        return false;
    }

    fprintf(stderr, "[NVENC] DLL loaded, NvEncodeAPICreateInstance found\n");

    // Check max supported version
    auto getMaxVer = (NvEncodeAPIGetMaxSupportedVersion_t)
        GetProcAddress(s_nvencDll, "NvEncodeAPIGetMaxSupportedVersion");
    if (getMaxVer) {
        uint32_t maxVer = 0;
        getMaxVer(&maxVer);
        uint32_t maxMajor = maxVer & 0xFF;
        uint32_t maxMinor = (maxVer >> 24) & 0xFF;
        fprintf(stderr, "[NVENC] Max supported API version: %u.%u (our: %u.%u)\n",
                maxMajor, maxMinor, NVENCAPI_MAJOR_VERSION, NVENCAPI_MINOR_VERSION);
        s_maxApiVersion = maxVer;
    }

    // Populate function list
    memset(&s_funcList, 0, sizeof(s_funcList));
    s_funcList.version = NV_ENCODE_API_FUNCTION_LIST_VER;

    fprintf(stderr, "[NVENC] Calling CreateInstance with version=0x%08x (struct size=%zu)\n",
            s_funcList.version, sizeof(s_funcList));

    NVENCSTATUS status = s_createInstance(&s_funcList);
    if (status != NV_ENC_SUCCESS) {
        fprintf(stderr, "[NVENC] NvEncodeAPICreateInstance failed: status=%u\n", status);
        FreeLibrary(s_nvencDll);
        s_nvencDll = nullptr;
        s_createInstance = nullptr;
        return false;
    }

    fprintf(stderr, "[NVENC] API initialized successfully\n");

    return true;
}

NV_ENCODE_API_FUNCTION_LIST* getNvencFunctions() {
    return s_nvencDll ? &s_funcList : nullptr;
}

void unloadNvenc() {
    memset(&s_funcList, 0, sizeof(s_funcList));
    s_createInstance = nullptr;
    if (s_nvencDll) {
        FreeLibrary(s_nvencDll);
        s_nvencDll = nullptr;
    }
}

bool isNvencLoaded() {
    return s_nvencDll != nullptr;
}

} // namespace nativeexporter
