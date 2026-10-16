import {createContext,useContext,useMemo,type ReactNode} from 'react';
import {createMaterialViewServices} from '../../core/services/materialViewServices';
import * as defaultServices from '../../core/services/materials';

export type MaterialViewIdentity={viewId:string;libraryId:string;visible:boolean;focused:boolean};
type Scope=MaterialViewIdentity&ReturnType<typeof createMaterialViewServices>;
const Context=createContext<Scope|null>(null);
export function MaterialViewProvider({identity,children}:{identity:MaterialViewIdentity;children:ReactNode}){
 const services=useMemo(()=>createMaterialViewServices(identity.libraryId),[identity.libraryId,identity.viewId]);
 const value=useMemo(()=>({...identity,...services}),[identity.viewId,identity.libraryId,identity.visible,identity.focused,services]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useMaterialViewScope=()=>useContext(Context);
export function useMaterialViewServices(){return useMaterialViewScope()?.services??defaultServices;}
