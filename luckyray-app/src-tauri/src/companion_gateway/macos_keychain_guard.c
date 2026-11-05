/* Public SDK bridge for one legacy Keychain identity read. No mutations,
 * private record APIs, transaction controls, raw blob decoding, or logging. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    SecKeychainRef keychain;
    SecKeychainItemRef item;
    CSSM_DL_DB_HANDLE database;
    CSSM_DB_UNIQUE_RECORD record;
} LRKeychainRecord;

void lr_macos_keychain_release(void *opaque) {
    LRKeychainRecord *guard = opaque;
    if (guard == NULL) return;
    /* Only these copied bytes are ours. The public item UID is borrowed and
     * must never be passed to CSSM_DL_FreeUniqueRecord by this bridge. */
    free(guard->record.RecordIdentifier.Data);
    if (guard->item != NULL) CFRelease(guard->item);
    if (guard->keychain != NULL) CFRelease(guard->keychain);
    free(guard);
}

static OSStatus record_status(CSSM_RETURN status) {
    if (status == CSSMERR_DL_RECORD_NOT_FOUND || status == CSSMERR_DL_INVALID_RECORD_UID
        || status == CSSMERR_DL_ENDOFDATA) return errSecInvalidItemRef;
    return (OSStatus)status;
}

static OSStatus verify_handles(LRKeychainRecord *guard) {
    CSSM_DL_DB_HANDLE current = {0};
    OSStatus status = SecKeychainGetDLDBHandle(guard->keychain, &current);
    if (status != errSecSuccess) return status;
    if (current.DLHandle != guard->database.DLHandle || current.DBHandle != guard->database.DBHandle)
        return errSecInvalidItemRef;
    status = SecKeychainItemGetDLDBHandle(guard->item, &current);
    if (status != errSecSuccess) return status;
    if (current.DLHandle != guard->database.DLHandle || current.DBHandle != guard->database.DBHandle)
        return errSecInvalidItemRef;
    return errSecSuccess;
}

static OSStatus verify_record(LRKeychainRecord *guard) {
    OSStatus status = verify_handles(guard);
    if (status != errSecSuccess) return status;
    CSSM_DB_RECORD_ATTRIBUTE_DATA attributes = {0};
    CSSM_RETURN result = CSSM_DL_DataGetFromUniqueRecordId(guard->database, &guard->record, &attributes, NULL);
    if (result != CSSM_OK) return record_status(result);
    return attributes.DataRecordType == CSSM_DL_DB_RECORD_GENERIC_PASSWORD ? errSecSuccess : errSecInvalidItemRef;
}

static OSStatus snapshot_record(LRKeychainRecord *guard) {
    const CSSM_DB_UNIQUE_RECORD *borrowed = NULL;
    OSStatus status = SecKeychainItemGetUniqueRecordID(guard->item, &borrowed);
    if (status != errSecSuccess) return status;
    if (borrowed == NULL) return errSecInvalidItemRef;
    const CSSM_DB_INDEX_INFO *locator = &borrowed->RecordLocator;
    /* Apple CSPDL exposes an opaque identifier with an empty locator. Reject
     * other layouts rather than shallow-copying possible locator pointers. */
    if (locator->IndexType != 0 || locator->IndexedDataLocation != 0
        || locator->Info.AttributeNameFormat != CSSM_DB_ATTRIBUTE_NAME_AS_STRING
        || locator->Info.Label.AttributeName != NULL || locator->Info.AttributeFormat != CSSM_DB_ATTRIBUTE_FORMAT_STRING
        || borrowed->RecordIdentifier.Data == NULL || borrowed->RecordIdentifier.Length == 0
        || borrowed->RecordIdentifier.Length > 4096) return errSecInvalidItemRef;
    guard->record.RecordIdentifier.Data = malloc((size_t)borrowed->RecordIdentifier.Length);
    if (guard->record.RecordIdentifier.Data == NULL) return errSecAllocate;
    guard->record.RecordIdentifier.Length = borrowed->RecordIdentifier.Length;
    memcpy(guard->record.RecordIdentifier.Data, borrowed->RecordIdentifier.Data,
           (size_t)borrowed->RecordIdentifier.Length);
    /* This is a snapshot of borrowed opaque bytes, not an independently owned
     * CSSM UID. Its lifetime relies on the retained item/public API contract.
     * The identity store is create-only; it never updates this item in-process. */
    return verify_record(guard);
}

/* ReturnRef + ReturnAttributes binds the same item's record during selection.
 * There is no independent second service/account query to associate with it. */
int32_t lr_macos_keychain_select(CFTypeRef keychain, CFDictionaryRef query, void **out_guard) {
    if (out_guard == NULL) return errSecParam;
    *out_guard = NULL;
    if (keychain == NULL || CFGetTypeID(keychain) != SecKeychainGetTypeID()
        || query == NULL || CFGetTypeID(query) != CFDictionaryGetTypeID()
        || CFDictionaryGetValue(query, kSecReturnRef) != kCFBooleanTrue
        || CFDictionaryGetValue(query, kSecReturnAttributes) != kCFBooleanTrue
        || CFDictionaryGetValue(query, kSecReturnData) != NULL) return errSecParam;
    LRKeychainRecord *guard = calloc(1, sizeof(*guard));
    if (guard == NULL) return errSecAllocate;
    guard->keychain = (SecKeychainRef)CFRetain(keychain);
    OSStatus status = SecKeychainGetDLDBHandle(guard->keychain, &guard->database);
    if (status != errSecSuccess) {
        lr_macos_keychain_release(guard);
        return status == errSecItemNotFound ? errSecInvalidItemRef : status;
    }

    CFTypeRef result = NULL;
    status = SecItemCopyMatching(query, &result);
    if (status == errSecSuccess) {
        CFTypeRef selected = result;
        if (selected != NULL && CFGetTypeID(selected) == CFArrayGetTypeID()) {
            CFIndex count = CFArrayGetCount((CFArrayRef)selected);
            if (count != 1) status = count > 1 ? errSecDuplicateItem : errSecInvalidItemRef;
            else selected = CFArrayGetValueAtIndex((CFArrayRef)selected, 0);
        }
        if (status == errSecSuccess) {
            if (selected == NULL || CFGetTypeID(selected) != CFDictionaryGetTypeID()) status = errSecInvalidItemRef;
            else {
                CFDictionaryRef attributes = (CFDictionaryRef)selected;
                const CFStringRef keys[] = { kSecClass, kSecAttrService, kSecAttrAccount };
                for (size_t index = 0; index < sizeof(keys) / sizeof(keys[0]); ++index) {
                    CFTypeRef expected = CFDictionaryGetValue(query, keys[index]);
                    CFTypeRef actual = CFDictionaryGetValue(attributes, keys[index]);
                    if (expected == NULL || actual == NULL || CFGetTypeID(expected) != CFStringGetTypeID()
                        || CFGetTypeID(actual) != CFStringGetTypeID() || !CFEqual(expected, actual)) {
                        status = errSecInvalidItemRef;
                        break;
                    }
                }
                if (status == errSecSuccess) {
                    CFTypeRef item = CFDictionaryGetValue(attributes, kSecValueRef);
                    if (item == NULL || CFGetTypeID(item) != SecKeychainItemGetTypeID()) status = errSecInvalidItemRef;
                    else guard->item = (SecKeychainItemRef)CFRetain(item);
                }
            }
        }
    }
    /* Always release any returned dictionary/array, without accepting a
     * failed query's result as a successful selection. */
    if (result != NULL) CFRelease(result);
    if (status != errSecSuccess) { lr_macos_keychain_release(guard); return status; }
    status = verify_handles(guard);
    if (status == errSecSuccess) status = snapshot_record(guard);
    if (status != errSecSuccess) {
        lr_macos_keychain_release(guard);
        /* A selected record disappearing is never a fresh-install signal. */
        return status == errSecItemNotFound ? errSecInvalidItemRef : status;
    }
    *out_guard = guard;
    return errSecSuccess;
}

void lr_macos_keychain_free_data(uint8_t *data, uint32_t length) {
    if (data == NULL) return;
    volatile uint8_t *bytes = data;
    for (uint32_t index = 0; index < length; ++index) bytes[index] = 0;
    (void)SecKeychainItemFreeContent(NULL, data);
}

int32_t lr_macos_keychain_read(void *opaque, uint8_t **out_data, uint32_t *out_length) {
    if (out_data == NULL || out_length == NULL) return errSecParam;
    *out_data = NULL;
    *out_length = 0;
    LRKeychainRecord *guard = opaque;
    if (guard == NULL || guard->item == NULL || guard->record.RecordIdentifier.Data == NULL) return errSecInvalidItemRef;
    OSStatus status = verify_record(guard);
    if (status != errSecSuccess) return status;
    SecItemClass item_class = 0;
    UInt32 length = 0;
    void *data = NULL;
    /* Keep the framework's normal integrity checks, authorization and decrypt. */
    status = SecKeychainItemCopyContent(guard->item, &item_class, NULL, &length, &data);
    if (status == errSecSuccess
        && (item_class != kSecGenericPasswordItemClass || data == NULL || length == 0 || length > 128u * 1024u))
        status = errSecInvalidItemRef;
    if (status == errSecSuccess) status = verify_record(guard);
    if (status != errSecSuccess) {
        lr_macos_keychain_free_data(data, length);
        return status;
    }
    *out_data = data;
    *out_length = length;
    return errSecSuccess;
}
