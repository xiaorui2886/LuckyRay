import {arrangeControls,filterControls,spaceControls,type WorkspacePresentation} from './presentation';
import {parsePluginPagePath} from '../app/shellNav';

export const navigationEntries = [
 {id:'materials',labelKey:'sidebar.route.materials',section:'space'},
 {id:'notes',labelKey:'sidebar.route.notes',section:'space'},
 {id:'graph',labelKey:'sidebar.route.graph',section:'space'},
 {id:'canvas',labelKey:'sidebar.route.canvas',section:'space'},
 {id:'community',labelKey:'sidebar.route.community',section:'space'},
 {id:'ai',labelKey:'sidebar.route.ai',section:'space'},
 {id:'tags',labelKey:'sidebar.route.tags',section:'filters'},
 {id:'collection',labelKey:'sidebar.route.collection',section:'filters'},
 {id:'favorites',labelKey:'sidebar.route.favorites',section:'filters'},
 {id:'smart',labelKey:'sidebar.route.smartFolders',section:'filters'},
] as const;

/** Older layouts used a separate General setting for Collection. Project it
 * once into the saved presentation; versioned layouts are their sole authority. */
export function resolveNavigationPresentation(presentation:WorkspacePresentation,legacyCollectionVisible:boolean):WorkspacePresentation {
 if(presentation.navigationVisibilityVersion===1)return presentation;
 const filters=presentation.navigation.filters;
 const hidden=legacyCollectionVisible?filters.hidden:[...new Set([...filters.hidden,'collection'])];
 return {...presentation,navigationVisibilityVersion:1,navigation:{...presentation.navigation,filters:{...filters,hidden}}};
}

export function setNavigationVisible(presentation:WorkspacePresentation,id:string,visible:boolean):WorkspacePresentation {
 const entry=navigationEntries.find(item=>item.id===id);
 if(!entry)return presentation; // Settings and non-navigation routes stay reachable.
 const current=presentation.navigation[entry.section];
 const hidden=current.hidden.filter(value=>value!==id);
 if(!visible)hidden.push(id);
 return {...presentation,navigation:{...presentation.navigation,[entry.section]:{...current,hidden}}};
}

export type NavigationVisibility = {presentation:WorkspacePresentation;pluginKeys:readonly string[]};
export function navigationRouteHidden(route:string,state:NavigationVisibility):boolean {
 const plugin=parsePluginPagePath(route);
 if(plugin)return !state.pluginKeys.includes(`${plugin.packageId}/${plugin.pageId}`);
 const entry=navigationEntries.find(item=>item.id===route.split(/[/?]/)[0]);
 return !!entry&&(state.presentation.navigation[entry.section].hidden.includes(entry.id));
}
export function visibleNavigationFallback(state:NavigationVisibility):string {
 const visible=[...arrangeControls(spaceControls.map(id=>({id})),state.presentation.navigation.space),...arrangeControls(filterControls.map(id=>({id})),state.presentation.navigation.filters)];
 return visible[0]?.id??'settings';
}
/** Hiding an active entry moves to a visible page. Later direct navigation is
 * still allowed: visibility never changes a feature's access or runtime state. */
export function newlyHiddenNavigationFallback(route:string,previous:NavigationVisibility|null,next:NavigationVisibility):string|null {
 if(!previous||!navigationRouteHidden(route,next)||navigationRouteHidden(route,previous))return null;
 return visibleNavigationFallback(next);
}
