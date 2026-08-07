/**
 * A minimal, valid IFC4 file to author into when there is no file to open.
 *
 * ## Why "new model" is not an empty string
 *
 * An IFC file with no project, no units, no representation context and no storey is not an empty model — it is
 * a file nothing can be added to. Every product needs a length unit to express its coordinates in, a `Body`
 * sub-context to hang its geometry on, and a storey to be contained by; without them an element is written
 * successfully and is invisible in every viewer, which is the failure mode this codebase keeps designing
 * against.
 *
 * So a new model starts as the smallest file that is genuinely authorable: Project → Site → Building → one
 * storey at 0 m, metres, and a `Body` context. `LocalModel` can create a missing context, but it should not
 * have to on the one path we fully control.
 *
 * The text is a literal rather than assembled by the emitter because it is a *fixture*, and a fixture that is
 * generated is a fixture that changes when the generator does. This one is stable, diffable, and byte-identical
 * every time — which matters because `EntityTable` guarantees an untouched entity is re-emitted verbatim, and
 * that guarantee is only useful if the starting bytes are predictable.
 */
export const BLANK_IFC4 = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('untitled.ifc','1970-01-01T00:00:00',(''),(''),'MassingViewer','@massingviewer/kernel-local','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#2= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3= IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4= IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5= IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#6= IFCUNITASSIGNMENT((#2,#3,#4,#5));
#7= IFCCARTESIANPOINT((0.,0.,0.));
#8= IFCAXIS2PLACEMENT3D(#7,$,$);
#9= IFCDIRECTION((0.,1.));
#10= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,#9);
#11= IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#12= IFCPROJECT('0MassingViewerProject0',$,'Untitled',$,$,$,$,(#10),#6);
#13= IFCLOCALPLACEMENT($,#8);
#14= IFCSITE('0MassingViewerSite0000',$,'Site',$,$,#13,$,$,.ELEMENT.,$,$,$,$,$);
#15= IFCLOCALPLACEMENT(#13,#8);
#16= IFCBUILDING('0MassingViewerBuilding',$,'Building',$,$,#15,$,$,.ELEMENT.,$,$,$);
#17= IFCLOCALPLACEMENT(#15,#8);
#18= IFCBUILDINGSTOREY('0MassingViewerLevel100',$,'Level 1',$,$,#17,$,$,.ELEMENT.,0.);
#19= IFCRELAGGREGATES('0MassingViewerAggreg01',$,$,$,#12,(#14));
#20= IFCRELAGGREGATES('0MassingViewerAggreg02',$,$,$,#14,(#16));
#21= IFCRELAGGREGATES('0MassingViewerAggreg03',$,$,$,#16,(#18));
ENDSEC;
END-ISO-10303-21;
`;
