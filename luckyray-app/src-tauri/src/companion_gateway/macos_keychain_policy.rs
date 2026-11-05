//! The identity read is deliberately split: metadata selects a guarded item
//! reference; password data is fetched only through that retained item.

#[derive(Clone, Copy)]
pub(super) enum QueryKind {
    References,
    Secret,
}

impl QueryKind {
    pub(super) fn limit_all(self) -> bool { matches!(self, Self::References) }
    pub(super) fn returns_item_reference(self) -> bool { matches!(self, Self::References) }
    pub(super) fn returns_data(self) -> bool { matches!(self, Self::Secret) }
}

pub(super) trait QueryBackend {
    type Reference;
    type Secret;
    type Error;

    // None is only the initial, explicit item-not-found status. An invalid or
    // empty success response must be rejected by the platform adapter.
    fn references(&self) -> Result<Option<Vec<Self::Reference>>, Self::Error>;
    fn secret(&self, reference: &Self::Reference) -> Result<Self::Secret, Self::Error>;
}

pub(super) enum ReadError<E> { Backend(E), Ambiguous }

pub(super) fn read<B: QueryBackend>(backend: &B) -> Result<Option<B::Secret>, ReadError<B::Error>> {
    let Some(mut references) = backend.references().map_err(ReadError::Backend)? else { return Ok(None) };
    if references.len() != 1 { return Err(ReadError::Ambiguous); }
    let reference = references.pop().expect("one reference");
    backend.secret(&reference).map(Some).map_err(ReadError::Backend)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixture {
        references: Option<Vec<u8>>,
        replace_after_search: bool,
        current_reference: Cell<u8>,
        reads: Cell<u32>,
    }
    impl Fixture {
        fn new(references: Option<Vec<u8>>, replace_after_search: bool) -> Self {
            Self { references, replace_after_search, current_reference: Cell::new(7), reads: Cell::new(0) }
        }
    }
    impl QueryBackend for Fixture {
        type Reference = u8;
        type Secret = &'static str;
        type Error = &'static str;
        fn references(&self) -> Result<Option<Vec<u8>>, Self::Error> {
            let selected = self.references.clone();
            if self.replace_after_search { self.current_reference.set(8); }
            Ok(selected)
        }
        fn secret(&self, reference: &u8) -> Result<Self::Secret, Self::Error> {
            self.reads.set(self.reads.get() + 1);
            // The replacement has identical content but a different reference.
            if *reference != self.current_reference.get() { Err("reference-lost") } else { Ok("identity") }
        }
    }

    #[test]
    fn macos_keychain_queries_never_combine_all_and_password_data() {
        let all = QueryKind::References;
        assert!(all.limit_all() && all.returns_item_reference() && !all.returns_data());
        let one = QueryKind::Secret;
        assert!(!one.limit_all() && !one.returns_item_reference() && one.returns_data());
    }

    #[test]
    fn macos_keychain_missing_and_ambiguous_results_never_read_a_secret() {
        let missing = Fixture::new(None, false);
        assert!(matches!(read(&missing), Ok(None)));
        let empty = Fixture::new(Some(vec![]), false);
        assert!(matches!(read(&empty), Err(ReadError::Ambiguous)));
        let multiple = Fixture::new(Some(vec![7, 8]), false);
        assert!(matches!(read(&multiple), Err(ReadError::Ambiguous)));
        assert_eq!(missing.reads.get() + empty.reads.get() + multiple.reads.get(), 0);
    }

    #[test]
    fn macos_keychain_replacement_with_equal_content_is_not_adopted() {
        let original = Fixture::new(Some(vec![7]), false);
        assert!(matches!(read(&original), Ok(Some("identity"))));
        let replaced = Fixture::new(Some(vec![7]), true);
        assert!(matches!(read(&replaced), Err(ReadError::Backend("reference-lost"))));
        assert_eq!(replaced.reads.get(), 1);
    }
}
