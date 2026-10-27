// Shared synthetic-browser theme commit. No production styles are changed.
// A nonzero reduced-motion duration can propagate inherited colors over several
// frames. Wait for the relevant elements/ancestors, not unrelated canvas effects.
module.exports = async function commitTheme(page, theme, selectors) {
  return page.evaluate(async ({theme,selectors}) => {
    document.documentElement.dataset.theme=theme;
    const started=performance.now(), deadline=started+1000, recorded=[];
    let stopped=false, timer, failure, stableFrames=0, previous='';
    const targets=()=>[...new Set(selectors.flatMap(selector=>[...document.querySelectorAll(selector)]))];
    const read=elements=>elements.map(el=>{const s=getComputedStyle(el);return {selector:el.className?.toString()||el.tagName,color:s.color,background:s.backgroundColor};});
    const relevantAnimations=elements=>{
      const relevant=new Set();
      for(const el of elements)for(let parent=el;parent;parent=parent.parentElement)relevant.add(parent);
      return document.documentElement.getAnimations({subtree:true}).filter(a=>relevant.has(a.effect?.target)&&a.effect?.getTiming().iterations!==Infinity&&(a.playState==='running'||a.pending));
    };
    const settle=async()=>{
      while(!stopped&&performance.now()<deadline){
        const elements=targets();read(elements); // Commit style before discovering transitions.
        const animations=relevantAnimations(elements);
        for(const a of animations)recorded.push({type:a.constructor.name,property:a.transitionProperty||null,name:a.animationName||null,duration:a.effect?.getTiming().duration,target:a.effect?.target?.className?.toString().slice(0,150)||'',elapsedMs:performance.now()-started});
        await Promise.all(animations.map(a=>a.finished.catch(()=>{})));
        await new Promise(resolve=>requestAnimationFrame(resolve));
        if(stopped)return;
        const current=targets(),signature=JSON.stringify(read(current));
        if(!relevantAnimations(current).length&&signature===previous)stableFrames++;else stableFrames=0;
        previous=signature;
        if(stableFrames>=2)return;
      }
      if(!stopped)throw new Error('Theme target styles did not settle within 1000ms');
    };
    try{await Promise.race([settle(),new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(new Error('Theme commit exceeded 1000ms'));},1000);})]);}
    catch(error){failure=String(error?.message||error);}
    finally{stopped=true;clearTimeout(timer);}
    return {theme,failure,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,elapsedMs:performance.now()-started,animations:recorded,styles:read(targets())};
  },{theme,selectors});
};
